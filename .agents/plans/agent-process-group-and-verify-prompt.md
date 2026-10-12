# Plan: Kill the Agent's Process Group, and Announce Verify in the Wave Prompt (#245, #250)
Created: 2026-10-12
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-12T15:04:04.715Z
Recorded-By: sean@torchcodelab.com
Branch: rad/agent-process-group-and-verify-prompt
Issue: 245
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/245
Issue-Title: Command adapter timeout orphans grandchild processes (kill the process group)

## Context
Two small, independent fixes from the 2026-10-09 factory-checks audit, both in the agent-adapter layer.

**#245 (bug, reproduced).** `harness/adapters/agent/command.js` and `acp.js` each spawn the agent without `detached` and each define their own `signalChild`, which sends the signal to `child.pid` only. When a wave times out, overflows output or aborts, the agent child dies but anything it started (a dev server, a test watcher, a backgrounded shell) survives and can keep touching the worktree. Reproduced with `runCommandPrompt` and a fake agent that runs `sleep 300 &`: the adapter returned on time and the grandchild was still alive. `sdk.js` has no `spawn` (the Claude Agent SDK owns its process), so it is out of scope.

**#250.** `buildWavePrompt` (`contract.js:158`) does not tell the agent the wave's own `Verify:` command or its timeout, so the agent learns the check only by failing it (`priorFailure`, #90). `planCtx` already carries `waveVerify` (`cli.js:782`, from `parseWaveVerify`) and reaches the builder as `{ ...planCtx, ...attemptCtx }`; the timeout is not in `planCtx` today (it is read from `RAD_VERIFY_TIMEOUT_SECONDS` by `scripts/check-verify.sh`, default 600).

Not covered by either issue and found while researching: `detached: true` puts the agent in its own session, so a terminal Ctrl-C on `rad deliver` no longer reaches it. `cli.js` and `spine.js` install no SIGINT/SIGTERM handler. Without a replacement the fix would turn a Ctrl-C into an orphaned agent, so the plan adds one (Task 1.1, AC#3).

## Scope
| In scope | Out of scope |
|---|---|
| A shared process-group helper used by the command and ACP adapters | The SDK adapter (no spawn of its own) |
| `detached` spawn and group signalling on timeout, output overflow, abort and normal shutdown | Windows support (POSIX only; behavior stated) |
| SIGINT/SIGTERM/exit cleanup of live agent groups | Sandboxing or credential scoping (#244) |
| A `## Verification` section in the wave prompt (command, timeout, or none) | Announcing attempt caps, doom-loop rule or push guard |
| Plumbing the verify timeout into `planCtx` | Changing how `Verify:` is parsed or run (see #236) |

## Acceptance Criteria
1. **Group kill on timeout.** When a command-adapter wave times out, the agent's whole process group is signalled SIGTERM and then SIGKILL after the grace; a backgrounded grandchild is dead afterwards. Asserted by a fixture agent that backgrounds a long `sleep`, hangs, and a test that the recorded grandchild pid is gone.
2. **Group kill on every other kill path.** Output-cap overflow and abort in `command.js`, and the output-cap kill and the SIGTERM/SIGKILL shutdown in `acp.js`, signal the group, not just the child pid.
3. **Ctrl-C does not orphan the agent.** A live agent group is killed when the harness process receives SIGINT or SIGTERM or exits; the harness then terminates with the original signal's normal exit behavior. Handlers are installed once, only while a group is live, and removed when none is.
4. **Platform behavior is explicit.** On `win32` the helper falls back to signalling the child pid only (no `detached`, no negative pid) and says so in a code comment and in `docs/rad-cli.md`. ESRCH on an already-gone group is not an error; any other signal failure is logged with the pid and signal.
5. **The prompt announces the check.** For a wave with a `Verify:` command, `buildWavePrompt` renders a `## Verification` section stating the command verbatim, that the harness runs it after the wave, and its timeout in seconds. For a wave with none it states that no `Verify:` is declared. The section sits before the volatile `priorFailure` block so a retry still extends the same prefix up to that block.
6. **The timeout shown is the timeout enforced.** `planCtx.verifyTimeoutSeconds` is resolved from `RAD_VERIFY_TIMEOUT_SECONDS` when it is a positive integer, else the default 600, with a comment tying the constant to `VERIFY_TIMEOUT_SECONDS_DEFAULT` in `scripts/check-verify.sh`.
7. **Existing behavior is preserved.** A malformed command (containing fence characters) is rendered inside a fence longer than any backtick run it contains, as the operator-context section does; the prior-failure and operator-context sections render exactly as before; no event, outcome or adapter-contract field changes.
8. **Full suite passes.** `scripts/verify-all.sh` passes on the delivered branch.

## Agent Scope
No sub-agents were called. Research was inline (7 tool calls): `command.js`, `acp.js`, `sdk.js` spawn/kill paths, `contract.js`/`cli.js` planCtx plumbing, SIGINT/SIGTERM grep, `check-verify.sh` timeout default.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/adapters/agent/process-group.js | 1-80 | New. `spawnOptions()`, `signalGroup(child, signal)`, `trackGroup`/`untrackGroup`, once-only SIGINT/SIGTERM/exit cleanup |
| harness/adapters/agent/command.js | 108-145 | Replace local `signalChild` with the shared group signal |
| harness/adapters/agent/command.js | 204-250 | `detached` spawn, track/untrack, overflow kill via group |
| harness/adapters/agent/acp.js | 160-170 | Replace local `signalChild` with the shared group signal |
| harness/adapters/agent/acp.js | 240-275 | `detached` spawn, track/untrack, stdout-cap kill via group |
| harness/adapters/agent/acp.js | 310-322 | Shutdown SIGTERM/SIGKILL via group |
| harness/adapters/agent/contract.js | 158-260 | Add `## Verification` section before `${priorFailureBlock}` |
| harness/cli.js | 735-790 | `parsePlanCtx` returns `verifyTimeoutSeconds` |
| harness/test/process-group.test.js | 1-120 | New. Helper unit tests (platform guard, ESRCH, cleanup handlers) |
| harness/test/command-adapter-kill.test.js | 1-140 | New. Timeout, overflow and abort leave no grandchild |
| harness/test/acp-adapter.test.js | 1-400 | Extend: ACP shutdown and cap kill signal the group |
| harness/test/fixtures/acp/fake-agent.mjs | 1-200 | Add `grandchild-hang` and `grandchild-flood` scenarios that start a background `sleep` and record its pid in the trace |
| harness/test/agent-contract.test.js | 72-106 | Extend: Verification section cases |
| docs/rad-cli.md | 1-1 | Note the process-group kill and POSIX-only behavior |

## Execution Notes

### Do Not Touch
- harness/gates.js, harness/gates.yaml, harness/matrix.yaml, harness/events.js
- harness/adapters/agent/sdk.js
- scripts/check-verify.sh (the timeout default is mirrored, not changed)

### Key Files
- harness/adapters/agent/command.js — spawnOnce, signalChild, killOnAbort
- harness/adapters/agent/acp.js — spawn, shutdown, stdout cap
- harness/adapters/agent/contract.js — buildWavePrompt, renderOperatorContext (the fence pattern to reuse)
- harness/cli.js — parseWaveVerify (592-631), parsePlanCtx (735-790)
- docs/invariants.yaml — `adapter-env-allow-listed` and the spawn-related invariants; run `scripts/lint-invariants.sh` after changing spawn anchors

### Reminders
- harness/ and scripts/ are self-protected: this plan needs architect approval and the last-wave full-suite Verify, run with `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- Fixture agents must clean up after themselves: kill any recorded pid in a `finally`, so a failing test cannot leak a `sleep`.
- Keep functions under ~40 lines (AGENTS.md); `spawnOnce` and `buildWavePrompt` are already on the over-long list (#251/#252), so extract helpers instead of growing them.
- Do not add content to the prompt after `${priorFailureBlock}`; the volatile block must stay last among the variable parts.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (1.1 is used by 1.2 and 1.3).
Verify: npm test --prefix harness

#### Task 1.1: Shared process-group helper
File: harness/adapters/agent/process-group.js
What: New module exporting `spawnOptions()` (returns `{ detached: true }` on POSIX, `{}` on win32), `signalGroup(child, signal)` (negative pid on POSIX; child pid on win32; skips an already-exited child; ESRCH is silent; other errors are written to stderr with pid and signal, as `signalChild` does today), and `trackGroup(child)` / `untrackGroup(child)`. The first tracked group installs SIGINT, SIGTERM and exit handlers once; the handler kills every tracked group with SIGKILL, then (for signals) removes itself and re-raises the signal so the process exits as it would have. The last untrack removes the handlers.
Validate: AC#3 — unit test: tracked group is killed on a simulated signal; handlers are absent when nothing is tracked. AC#4 — win32 fallback and ESRCH cases.

#### Task 1.2: Command adapter uses the group
File: harness/adapters/agent/command.js:108-145, 204-250
What: Spawn with `...spawnOptions()`; track on spawn and untrack on close; `signalChild` becomes a thin call to `signalGroup`; the output-cap `child.kill('SIGKILL')` becomes `signalGroup(child, 'SIGKILL')`.
Validate: AC#1, AC#2 — `command-adapter-kill.test.js`: fake agent starts `sleep 300 &`, writes the pid, hangs; after timeout, overflow and abort the pid is gone.

#### Task 1.3: ACP adapter uses the group
File: harness/adapters/agent/acp.js:160-170, 240-275, 310-322
What: Same change for the ACP child: detached spawn, track/untrack, the local `signalChild` delegates to `signalGroup`, so the stdout-cap kill and `shutdown` signal the group. The existing fake ACP agent fixture (`harness/test/fixtures/acp/fake-agent.mjs`) gains two additive scenarios, `grandchild-hang` and `grandchild-flood`, that start a background `sleep` and record its pid; existing scenarios are untouched.
Validate: AC#2 — extend `acp-adapter.test.js` with a fake ACP agent that backgrounds a child; shutdown and the cap kill leave no grandchild.

### Wave 2 — sequential
Tasks in this wave must run in sequence (2.2 depends on the field added in 2.1).
Verify: exec bash scripts/verify-all.sh

#### Task 2.1: Resolve the verify timeout into planCtx
File: harness/cli.js:735-790
What: `parsePlanCtx` returns `verifyTimeoutSeconds`: `RAD_VERIFY_TIMEOUT_SECONDS` when a positive integer (no sign, no whitespace, no zero), else a named constant `VERIFY_TIMEOUT_SECONDS_DEFAULT = 600` with a comment keeping it in lockstep with `scripts/check-verify.sh`. A malformed env value falls back to the default; `check-verify.sh` still hard-fails it at run time.
Validate: AC#6 — unit test over unset, valid, zero, negative, non-numeric and whitespace values.

#### Task 2.2: Render the Verification section
File: harness/adapters/agent/contract.js:158-260
What: A helper `renderVerification(waveVerify, waveNumber, timeoutSeconds)` returns the `## Verification` section, placed before `${priorFailureBlock}`. With a command: the command in a fence longer than any backtick run in it, a sentence that the harness runs it after the wave and treats a non-zero exit as a failed attempt, and the timeout. Without: one line stating no `Verify:` is declared. Extracted as a helper, not inlined, to avoid growing `buildWavePrompt`.
Validate: AC#5, AC#7 — tests in `agent-contract.test.js`: command present, command absent, command containing backticks, timeout value shown, section order (before prior-failure), prior-failure and operator-context sections byte-identical to before.

#### Task 2.3: Docs
File: docs/rad-cli.md
What: Note that agent children run in their own process group and are killed as a group (POSIX only; Windows signals the child only), and that Ctrl-C kills live agent groups. Note the wave prompt's `## Verification` section.
Validate: AC#4, AC#8 — the platform behavior is stated; `bash scripts/lint-claude-md.sh` and the full suite (`scripts/verify-all.sh`) pass.

## Tests to Write
- [ ] Helper: group signal, win32 fallback, ESRCH, once-only handlers, cleanup — harness/test/process-group.test.js
- [ ] Command adapter: timeout, overflow and abort leave no grandchild — harness/test/command-adapter-kill.test.js
- [ ] ACP adapter: shutdown and stdout-cap kill signal the group — harness/test/acp-adapter.test.js
- [ ] Prompt: Verification section cases and ordering — harness/test/agent-contract.test.js
- [ ] planCtx: verifyTimeoutSeconds resolution cases — harness/test/ (alongside the parsePlanCtx tests)

## Non-Goals
- Sandboxing the agent or scoping its credentials (#244)
- Making `sdk.js` kill a process group (the SDK owns its child)
- Announcing the attempt cap, doom-loop rule or push guard in the prompt
- Windows process-tree killing

## Out-of-Scope Dependencies
None.

## Risks
- `detached: true` changes signal delivery. Mitigated by AC#3 (SIGINT/SIGTERM/exit cleanup) and tested explicitly; if the handler misbehaves the failure mode is an orphaned agent, which is the status quo this plan is fixing.
- Re-raising the signal after cleanup must not skip other handlers or leave the harness hung. Covered by the helper unit tests.
- The prompt gains a section for every wave, so all prompts change by design. Existing `agent-contract.test.js` assertions that match exact text must be updated deliberately, not loosened.
- The announced timeout could differ from the enforced one if the env var is malformed; `check-verify.sh` then hard-fails the run, so the mismatch is not silent.

## Issue Gaps
- ASSUMPTION: #245 names `command.js`/`acp.js` as the fix sites; the plan adds a shared module rather than duplicating the change, because both files already duplicate `signalChild`. Verify this is acceptable under the ~40-line and shared-helper conventions.
- ASSUMPTION: the SIGINT/SIGTERM/exit cleanup (AC#3) was not in either issue; it is added because `detached` would otherwise make Ctrl-C orphan the agent. Confirm this is wanted here and not a separate issue.
- ASSUMPTION: `sdk.js` is excluded because it has no spawn; the issue says to verify `acp.js` and `sdk.js`. Confirmed by grep: only `command.js` and `acp.js` call `spawn`.
- ASSUMPTION: the prompt's `Verify: none (reason)` wording (#250) depends on #236, which has not landed. This plan handles only "no `Verify:` declared"; a `none (reason)` follow-up belongs with #236.
- AMENDED 2026-10-12 after the first delivery attempt stopped on `fail-scope`: the ACP fake-agent fixture was an undeclared file the group-kill test needs. It is now in Files in Scope; the agent's change to it was reviewed and is additive only.
- ASSUMPTION: the `## Verification` section goes before the prior-failure block (stable head) rather than at the very top; #112 (closed) is the reason prefix placement matters.
