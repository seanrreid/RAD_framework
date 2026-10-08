# Plan: rad deliver Hardening — Logs, Wave Timeout, stop-status (#218, #211, #212)
Created: 2026-10-08
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-08T16:49:51.800Z
Recorded-By: sean@torchcodelab.com
Branch: rad/deliver-hardening
Issue: 218
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/218
Issue-Title: Untracked execution log blocks worktree teardown after a successful rad deliver

## Context
The first live end-to-end runs of `rad deliver` (#186 part 3d) surfaced three small, independent defects. Each was decided on 2026-10-08 as needing no design choice:
- **#218:** wave agents write an execution log (`.agents/logs/<f>-<date>.md`, path given in the prompt via `planCtx.executionLog`) that nothing commits. On success, `commitRunEvents` stages only `.agents/state/<f>/`, so the non-forced worktree removal refuses and the run exits **1 after delivering** (PR #217).
- **#211:** the command adapter's wave timeout is hardcoded at 600 s (`createCommandAdapter`, harness/adapters/agent/command.js:373), and there's no setting. A wave that legitimately needs longer can only fail with `fail-timeout`.
- **#212:** `rad stop-status` reads the main checkout's event log (`createGitStateStore({ repoRoot }).history`), so in worktree mode it can't see a stop. That's now on the branch tip, per #210.

Also: docs/rad-cli.md:956-959 still says the `/rad-deliver` skill "runs wave sub-agents in the checkout" and is an unguarded bypass. Since 3d it runs `rad deliver`, and invariants.yaml records it as guarded.

## Scope
| In scope | Out of scope |
|---|---|
| Commit the run's execution log with its events (success and stop) | #216 (resume reuse vs. the prepare merge), which needs a design decision |
| `RAD_WAVE_TIMEOUT_SECONDS` for the command and acp adapters | The SDK adapter's timeout |
| `rad stop-status` reads history the way `--resume` does | Changing what the wave prompt asks agents to write |
| Correct the stale rad-cli.md skill-path paragraph | |

## Acceptance Criteria
1. **The execution log is committed (#218).**
   - `commitRunEvents` (success) and `commitStopEvents` (stop) also stage and commit the run's execution logs: every file matching `.agents/logs/<feature>-*.md` under the run root, found with `readdirSync` and named explicitly. There are no globs passed to git and no `-A`.
   - `commitStopEvents` keeps its pathspec commit (events plus those logs only).
   - When no such log exists, every git call is exactly as today.
   - A successful worktree run with an agent-written log tears down cleanly and exits 0.
2. **A configurable wave timeout (#211).**
   - `RAD_WAVE_TIMEOUT_SECONDS`: a positive integer gives the per-wave wall-clock deadline for the command and acp adapters (passed as `timeoutMs`).
   - Unset or empty keeps today's default of 600 s.
   - A malformed value (non-integer, zero, negative, whitespace) makes `rad deliver` exit **2** before any wave or event, with `rad deliver: RAD_WAVE_TIMEOUT_SECONDS must be a positive integer (got '<raw>')`.
   - Parsing reuses the `RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS` pattern (cli.js ~760-770). The SDK path ignores the variable.
3. **stop-status reads the branch tip in worktree mode (#212).** Without `--stdin`, `rad stop-status <f>` reads history through `readResumeHistory`: the branch tip in worktree mode, and the checkout's log in main mode. A read failure keeps today's exit and message. `--stdin` is unchanged.
4. **Docs.**
   - docs/rad-cli.md:956-959: the skill now runs `rad deliver`, so the same isolation applies; only `RAD_WORKTREE=0` remains the opt-out bypass.
   - `RAD_WAVE_TIMEOUT_SECONDS` is added to rad-cli.md's env table (~695) and exit-2 row (~823), and to docs/configuration.md's env list (~225-250).
   - rad-cli.md `### rad stop-status` (~278) says which log it reads in each mode.
   - rad-cli.md's worktree lifecycle notes that the run's execution log is committed with its events.
5. **Tests.**
   - harness/test/worktree.test.js: a success run with a `.agents/logs/<f>-<date>.md` present stages and commits it, and teardown proceeds; a stop commits events plus the log through the pathspec; no log means the git calls are unchanged.
   - harness/test/cli.test.js:
     - `RAD_WAVE_TIMEOUT_SECONDS` valid (reaches the adapter as `timeoutMs`), unset (default), and malformed (exit 2 with the message, no events);
     - `stop-status` in worktree mode reporting a stop that exists only at the branch tip, and in main mode unchanged.
   - No existing assertion changes. If one must, list it.

## Agent Scope
Research came from targeted greps of the commit helpers, `finishWorktree`, the preflight-timeout parsing, `buildCmdAdapter`/`buildRunWave`, the adapters' timeout options, `stopStatusCommand` and `readResumeHistory`, and the docs. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/cli.js | 240-252 | `WAVE_TIMEOUT_ENV` constant |
| harness/cli.js | 755-810 | Read: the preflight-timeout parsing pattern |
| harness/cli.js | 1036-1075 | `buildCmdAdapter`/`buildRunWave`: pass `timeoutMs`; malformed → exit 2 |
| harness/cli.js | 1290-1360 | `commitRunEvents`, `commitStopEvents`: include the execution logs |
| harness/cli.js | 1400-1420 | Read: `readResumeHistory` |
| harness/cli.js | 2895-2940 | `stopStatusCommand`: read via `readResumeHistory` |
| harness/adapters/agent/command.js | 365-380 | Read only: `createCommandAdapter` `timeoutMs` |
| harness/adapters/agent/acp.js | 555-575 | Read only: `createAcpAdapter` `timeoutMs` |
| harness/test/worktree.test.js | 1-1 | Append (AC#5) |
| harness/test/cli.test.js | 1180-1240 | Read: the stop-status test pattern; append cases (AC#5) |
| docs/rad-cli.md | 275-300 | `### rad stop-status` |
| docs/rad-cli.md | 690-700 | Env table |
| docs/rad-cli.md | 820-826 | Exit-2 row |
| docs/rad-cli.md | 950-980 | Skill-path paragraph and lifecycle |
| docs/configuration.md | 225-250 | Env list |

## Execution Notes

### Do Not Touch
- harness/spine.js, harness/transitions.js, harness/gates.*
- harness/adapters/agent/*: they already accept `timeoutMs`
- scripts/worktree-lifecycle.sh
- #216's behavior (the resume reuse and prepare merge)

### Key Files
- harness/cli.js: `PREFLIGHT_TIMEOUT_ENV` (247), the preflight timeout parser (~760-770), `buildCmdAdapter` (1038), `buildRunWave` (1056), `commitRunEvents` (1296), `commitStopEvents` (1316), `finishWorktree` (1339), `readResumeHistory` (1405), `stopStatusCommand` (2902)
- harness/test/worktree.test.js: `makeDeliverSh` and `runDeliver` helpers, and the run-events tests
- harness/test/cli.test.js: the stop-status helper (~1184-1200)

### Reminders
- **Waves run under a 10-minute agent limit (#211, which this plan fixes, but not for its own run).** Validate with only the targeted test files; the reviewer runs the full suites after.
- **Every git call is an args array through `sh`, with explicit paths.** Never `-A`, never globs.
- **No new log, no new env var: behavior is byte-identical.**
- **Helpers stay under ~40 lines, with named constants.**

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: Commit the execution log
File: harness/cli.js:1290-1360, harness/test/worktree.test.js:1-1
What: Write AC#1 and its worktree.test.js cases. Add a small helper that lists `.agents/logs/<feature>-*.md` under the root with `readdirSync`, returning `[]` when the directory is missing. Use it in both commit helpers.
Validate: AC#1, AC#5 — `node --test harness/test/worktree.test.js` passes

### Wave 2 — sequential

#### Task 2.1: Configurable wave timeout
File: harness/cli.js:240-252, 1036-1075, harness/test/cli.test.js:1180-1240, docs/rad-cli.md:690-700, 820-826, docs/configuration.md:225-250
What: Write AC#2, its cli.test.js cases (append), and its docs (the env table, the exit-2 row, configuration.md).
Validate: AC#2, AC#5 — `node --test harness/test/cli.test.js` passes; `grep -n RAD_WAVE_TIMEOUT_SECONDS docs/rad-cli.md docs/configuration.md` matches in both

### Wave 3 — sequential

#### Task 3.1: stop-status reads the branch tip, and the docs
File: harness/cli.js:2895-2940, harness/test/cli.test.js:1180-1240, docs/rad-cli.md:275-300, 950-980
What: Write AC#3 with its cli.test.js cases (append), plus the AC#4 docs for stop-status, the skill-path paragraph and the lifecycle note.
Validate: AC#3, AC#4, AC#5 — `node --test harness/test/cli.test.js` passes; `grep -n "runs wave sub-agents in the checkout" docs/rad-cli.md` returns nothing

## Tests to Write
- [ ] Execution log committed on success and stop; unchanged without a log — harness/test/worktree.test.js
- [ ] RAD_WAVE_TIMEOUT_SECONDS valid, unset, malformed; stop-status branch tip vs checkout — harness/test/cli.test.js

## Non-Goals
- #216 (resume reuse vs. the prepare merge).
- An SDK-adapter timeout, or a config-file key for the timeout.
- Changing the wave prompt's execution-log instruction.

## Out-of-Scope Dependencies
None

## Risks
- **Committing agent-written logs adds a file per run to the branch.** It's a process artifact like the event log, and `check-scope` exempts `.agents/`.
- **This plan's own delivery still uses the 600 s default and still hits #218's exit 1 at teardown** (the fix isn't on main yet). Both are expected; the reviewer cleans up by hand one last time.
- **Self-protected paths** (`harness/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — logs are matched by `<feature>-*.md`** (the `executionLog` naming). Other files under `.agents/logs/` are never touched.
- **Assumption — the timeout variable covers the command and acp adapters only.** The SDK adapter has its own lifecycle.
- **Assumption — the plan header carries `Issue: 218`.** #211 and #212 are named in the title and Context, and are closed by hand after merge.
