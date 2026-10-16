# Plan: Permission Refusal as Its Own Stop
Created: 2026-10-16
Author: architect
Status: pending-review
Branch: rad/permission-refusal-stop
Issue: 287
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/287
Issue-Title: rad deliver: the claude command preset sets no permission mode, so a delivery can write only what the launching session allows
Source-Author: seanrreid (OWNER)
Source-Comments: 1 total, 0 non-collaborator

## Context
Items 1 and 4 of #287 shipped in #290. Item 2 remains: when the headless agent is refused a tool or a write, the refusal reaches the harness as `fail-scope` (agent tags it `blocked_intent`) or as a `fail-tests` doom loop (agent tags it `blocked_code`), as happened to wave 2 of #290 when `bash scripts/verify-all.sh` was refused. Neither names the denied tool or path, and the doom loop retries a failure that cannot change. `claude -p --output-format json` reports `permission_denials`; this plan carries them from the wrapper to a dedicated, never-retried stop.

## Scope
| In scope | Out of scope |
|---|---|
| Wrapper emits a `RAD_DENIALS {json}` line from `permission_denials` | Item 3: rerun dead end after `finish-failed` |
| Command adapter extracts it onto the wave result | Preventing the refusal (item 1, shipped) |
| New `permission-denied` stop, no retry, naming tool and path | SDK adapter denials (it sets `acceptEdits` and an allow-list already) |
| Docs for the line and the stop | Codex/aider wrappers |

## Acceptance Criteria
1. When the CLI result carries a non-empty `permission_denials` array, `claude-usage.mjs` prints a `RAD_DENIALS {json}` line (after the `RAD_USAGE` line, before the result text) holding at most 10 entries of `{tool, path}`; with none or malformed data, no line is printed and the existing output is byte-identical.
2. The command adapter parses the first `RAD_DENIALS` line from stdout into `result.denials` (array of `{tool, path}`, each string capped, at most 10); a malformed line or entries missing both fields are dropped, never thrown.
3. When an attempt's outcome is not advancing and its result carries denials, the run stops at once with `stopped: 'permission-denied'`, class `failed`, with no retry and no doom-loop verdict; the decision text names each denied tool and path and points at the agent's permission configuration.
4. An attempt with denials whose outcome still advances (the agent worked around them) is unchanged: no stop.
5. The `wave-attempt` event for the stopped attempt records the denials, and the `deliver-stopped` event carries `reason: 'permission-denied'`.
6. `docs/rad-wave-contract.md` documents the `RAD_DENIALS` line and the stop.

## Agent Scope
Research ran inline (no sub-agent): `harness/stops.js`, `harness/spine.js` (stop sites, `recordAttempt`, scope demotion), `harness/adapters/agent/command.js` (`extractUsage`), `harness/adapters/agent/contract.js` (`toWaveResult`), `harness/matrix.yaml`, `scripts/claude-usage.mjs`, `docs/rad-wave-contract.md`. No out-of-scope agents.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/claude-usage.mjs | 11-30, 70-85 | Build and print the `RAD_DENIALS` line from `permission_denials` |
| scripts/test-claude-usage.sh | 100-175 | Scenarios: denials printed, none, malformed, capped at 10 |
| harness/adapters/agent/command.js | 372-395, 540-600 | `extractDenials` beside `extractUsage`; attach to the wave result |
| harness/adapters/agent/contract.js | 487-497 | `toWaveResult` passes `denials` through when present |
| harness/spine.js | 59-70, 940-1045 | After the attempt is recorded, stop with `permission-denied` before retry/doom-loop; record denials on the event |
| harness/stops.js | 45-100 | `permission-denied` row, class FAILED, decision rendering tool and path |
| harness/test/stops.test.js | 1-60 | Row classification and decision text |
| harness/test/spine.test.js | 1-80 | Stop on refusal, no retry, advancing-outcome unchanged |
| harness/test/contract-characterization.test.js | 1-60 | `toWaveResult` denials passthrough and absence |
| docs/rad-wave-contract.md | 98-150, Stop contract section | Document the line and the stop |

## Program Design
Signatures:
- `buildDenials(parsed) -> Array<{tool, path}> | null` (scripts/claude-usage.mjs)
- `extractDenials(stdout) -> Array<{tool, path}> | undefined` (command.js)
- `toWaveResult(parsed, usage, denials?)` adds `denials` only when non-empty (contract.js)

Call stack: `claude -p` JSON -> claude-usage.mjs prints `RAD_USAGE`, `RAD_DENIALS`, text -> command adapter `extractDenials` -> `result.denials` -> spine `recordAttempt` (event carries denials) -> if action != advance and denials: `stopRun({stopped:'permission-denied'})` -> `stops.js` classifies FAILED.

File-tree diff: no new files; edits only to the files in Scope.

## Execution Notes

### Do Not Touch
- `harness/matrix.yaml` and `harness/gates.js`: no new matrix outcome; the stop is raised by the spine, not the matrix
- `harness/adapters/agent/sdk.js`

### Key Files
- `harness/stops.js` — every terminal must be in `STOP_TABLE`; unknown shapes throw (fail-closed)
- `harness/spine.js` — `recordAttempt` appends the `wave-attempt` event; the new stop must come after it so the denial is on the log
- `scripts/claude-usage.mjs` — self-contained, installed into consumer projects: no imports from `harness/` or `scripts/vendor/`

### Reminders
- Sanitize and cap denial strings (paths and tool names are agent-influenced input that ends up in the stop message and event log).
- New or changed shell scripts keep mode 100755; `scripts/` files here are existing.

## Wave Plan

### Wave 1 — parallel
Tasks 1.1 and 1.2 touch disjoint files.

#### Task 1.1: Wrapper emits `RAD_DENIALS`
File: scripts/claude-usage.mjs:11-30, 70-85, scripts/test-claude-usage.sh:100-175
What: Add `buildDenials(parsed)` returning up to `MAX_DENIALS` (10) `{tool, path}` entries from `parsed.permission_denials` (tool from `tool_name`, path from `tool_input.file_path` or `tool_input.path`, else `command` truncated to 200 chars); non-array or empty yields null. `renderOutput` prints `RAD_DENIALS {json}\n` after the `RAD_USAGE` line and before the text only when non-null. Scenarios for printed, absent, malformed entries, and more than 10.
Validate: AC#1 — `bash scripts/test-claude-usage.sh` asserts exact stdout for each scenario, and the no-denials scenarios match the existing output.

#### Task 1.2: Adapter extracts denials
File: harness/adapters/agent/command.js:372-395, 540-600, harness/adapters/agent/contract.js:487-497, harness/test/contract-characterization.test.js
What: Add `extractDenials(stdout)` matching `^RAD_DENIALS\s+(\[.*\])\s*$` (first match), keep only entries with a string `tool` or `path`, cap strings at 200 chars and the list at 10, return undefined on none or malformed JSON. Pass the result into `toWaveResult` as `denials`, set on the result only when non-empty.
Validate: AC#2 — contract tests: valid line, malformed JSON, non-array, entries missing both fields, over-cap, absent.

### Wave 2 — sequential
Depends on `result.denials` from wave 1.

#### Task 2.1: The `permission-denied` stop
File: harness/stops.js:45-100, harness/spine.js:59-70, 940-1045, harness/test/stops.test.js, harness/test/spine.test.js
What: Add `'permission-denied'` to `STOP_TABLE` (class FAILED, decision `permission refused: {detail}; grant it in the agent's permission configuration (e.g. --permission-mode / --allowedTools in the command) and re-run`). In the spine, after `recordAttempt` and only when the resolved action is not `advance` and `result.denials` is non-empty, return `stopRun({ stopped: 'permission-denied', ok: false, wave, detail, reason: 'permission-denied' })` before the retry/revision and doom-loop paths. Record `denials` on the `wave-attempt` event (spread, absent when none). Tests: stop with no second attempt, decision names tool and path, advancing outcome with denials does not stop, no denials is byte-identical to today, `fail-scope` plus denials stops as `permission-denied`.
Validate: AC#3, AC#4, AC#5 — `node --test harness/test/stops.test.js harness/test/spine.test.js`.

### Wave 3 — sequential
#### Task 3.1: Document the line and the stop
File: docs/rad-wave-contract.md:98-150
What: Add a `RAD_DENIALS` subsection beside `RAD_USAGE` (format, caps, first-match, malformed ignored), a bullet in the `claude` wrapper list, and the `permission-denied` row in the Stop contract (class failed, never retried, what the decision names).
Validate: AC#6 — grep for `RAD_DENIALS` and `permission-denied`; `bash scripts/verify-all.sh` doc checks pass.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] `RAD_DENIALS` printed, absent, malformed, capped — scripts/test-claude-usage.sh
- [ ] `extractDenials` / `toWaveResult` passthrough and drops — harness/test/contract-characterization.test.js
- [ ] `permission-denied` row classification and rendering — harness/test/stops.test.js
- [ ] stop on refusal without retry; advancing outcome unchanged; fail-scope plus denials — harness/test/spine.test.js

## Non-Goals
- Item 3 of #287 (the rerun dead end after `finish-failed`).
- Preventing refusals or choosing the agent's permission mode (item 1, shipped in #290).
- Denial detection for the SDK, Codex or aider adapters.
- Resuming a `permission-denied` stop automatically; the operator fixes the permission config and re-runs.

## Out-of-Scope Dependencies
None

## Risks
- Touches `harness/` and `scripts/`: self-protected, architect review applies; deliver with `RAD_VERIFY_TIMEOUT_SECONDS=1800`, from a session whose headless shell calls are allowed (wave 2 of #290 was lost to exactly this refusal).
- Spine control flow is the determinism boundary: the new stop must not change behavior for results without denials (covered by the byte-identical test).
- `permission_denials` field names (`tool_name`, `tool_input`) come from Claude Code 2.1.x output and are unverified in this repo; a changed shape degrades to no line, i.e. today's behavior.

## Issue Gaps
- ASSUMPTION: a refusal stops the run only when the attempt does not advance; denials alongside a successful outcome are ignored. The issue says refusals should "never be retried" but does not cover work-arounds.
- ASSUMPTION: class `failed` (not `needs-decision`), because re-running unchanged cannot succeed; the operator changes configuration, then re-runs.
- ASSUMPTION: the stop is raised by the spine from `result.denials`, with no new matrix outcome, so `matrix.yaml` is untouched.
- ASSUMPTION: the `permission_denials` entry shape (`tool_name`, `tool_input.file_path`/`path`/`command`) matches Claude Code 2.1.x; the issue does not specify it. The wrapper tolerates other shapes by emitting nothing. [Architect to verify against a real refusal]
