# Plan: Agent Startup Preflight
Created: 2026-09-25
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-25T15:38:17.081Z
Recorded-By: sean@torchcodelab.com
Branch: rad/agent-startup-preflight
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/114
Issue-Title: Agent adapter gives no diagnosis when RAD_AGENT_CMD cannot authenticate: startup failure is misclassified as blocked_code and retried

## Context

On 2026-08-20 a deliver of `insights-read-side-folds` failed at Wave 1 with
`command exited with code 1:` and nothing after the colon. The configured
`claude -p` could not authenticate under the command adapter's allow-listed env.
#117 already shipped two parts of the fix: `USER` in `ENV_ALLOW_LIST`, and a stdout
fallback so the diagnosis reaches the event log. Two gaps remain, and this plan
covers only those.

- **Misclassification.** A non-zero exit becomes `syntheticFailure` → `blocked_code` → `fail-tests`, which the matrix maps to `revision`. An agent that can't start therefore burns the whole attempt budget on identical failures until the doom-loop breaker stops it.
- **No early signal.** Nothing checks whether the command can run at all until Wave 1 has already started.

The contract that `RAD_AGENT_CMD` must authenticate without inherited env is also
undocumented.

## Scope

| In scope | Out of scope |
|---|---|
| Command adapter: a non-zero exit or spawn error with no `WAVE_RESULT` block returns `fail-protocol` (matrix `abort`, no retry) | `ENV_ALLOW_LIST` contents and the stdout fallback (shipped in #117) |
| An exported `probeCommand` in `command.js`, reusing the adapter's argv, env and spawn semantics exactly | Changing `contract.js` `syntheticFailure` / `resultToOutcome` (shared with the SDK adapter) |
| `rad deliver` runs the probe on the command path after the gate check and before any worktree or event; failure exits 1 with a specific message | A preflight for `RAD_AGENT=sdk` (separate issue) |
| `RAD_AGENT_PREFLIGHT=off` opt-out | `matrix.yaml`, `matrix.js`, `spine.js`, `events.js` and `transitions.js` (no new event, reason or terminal) |
| Document the env-less auth contract in CLAUDE.md, `.env.example`, `docs/rad-cli.md` and `docs/rad-wave-contract.md` | A credential-passthrough env var (the issue explicitly rejects it) |

## Acceptance Criteria

1. When the command adapter's agent exits non-zero and its stdout contains no `WAVE_RESULT` block, the wave result has `outcome: 'fail-protocol'` and `status: 'failed'`, and the error keeps #117's sanitized, capped stderr-or-stdout excerpt. A spawn error (e.g. ENOENT) also yields `fail-protocol`. A non-zero exit that *does* emit a `WAVE_RESULT` block is parsed as before.
2. With AC#1 in place, a deliver whose agent can never start stops after **one** attempt via the matrix `abort` action (`wave-failed {wave:1, action:'abort'}`), not after retries or the doom-loop breaker.
3. `probeCommand({ cmd, repoRoot })` is exported from `command.js`. It spawns the configured command with the adapter's exact argv construction and allow-listed env, feeds a fixed one-line probe prompt on stdin under a named timeout constant, and resolves `{ ok: true }` on exit 0 or `{ ok: false, error }` otherwise (non-zero exit, spawn error or timeout). `error` carries the sanitized, capped stderr-or-stdout excerpt. It never parses the agent's reply.
4. On the command path, `rad deliver` runs `probeCommand` after the approval gate and before worktree creation and `deliver-started`. On failure it writes `rad deliver: RAD_AGENT_CMD failed to start under the adapter env (it must authenticate without inherited env vars): <error>` to stderr, returns 1, and appends no events.
5. `RAD_AGENT_PREFLIGHT=off` skips the probe. `RAD_AGENT=sdk`, and an injected `ctx.runWave`, never run it. Any other value of `RAD_AGENT_PREFLIGHT` (including unset) runs it.
6. CLAUDE.md (Agent Adapter), `.env.example`, `docs/rad-cli.md` and `docs/rad-wave-contract.md` state that `RAD_AGENT_CMD` must authenticate without inherited env (disk or OS keychain, not env-injected tokens), name the failure mode, document the preflight and its opt-out, and show the startup-failure → `fail-protocol` row.
7. `npm test --prefix harness` passes. Existing `deliver.test.js` cases (which inject `runWave`) are unaffected, and any #117 stdout-fallback test whose expected outcome changes is updated deliberately, with the rationale in the commit message.

## Agent Scope

No agents were called. Research was one Explore sub-agent (10 of 10 searches)
covering `command.js`, `contract.js`, `matrix.yaml`, `spine.js`, `cli.js`,
`events.js`, the adapter and deliver tests, and the docs.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/adapters/agent/command.js | 40-281 | Startup-failure classification in `runCommand`; new exported `probeCommand` and probe constants |
| harness/cli.js | 460-500 | Run `probeCommand` in the command branch of `deliverCommand`, honouring `RAD_AGENT_PREFLIGHT=off` |
| harness/test/agent-adapters.test.js | 1-480 | Classification, probe and `deliverCommand` preflight tests; update affected #117 fallback expectations |
| CLAUDE.md | 105-121 | Agent Adapter: env-less auth contract, preflight and `RAD_AGENT_PREFLIGHT` |
| .env.example | 12-20 | Warn on the `RAD_AGENT_CMD` example; document `RAD_AGENT_PREFLIGHT` |
| docs/rad-cli.md | 100-130 | Command-path credential rules, preflight message and opt-out |
| docs/rad-wave-contract.md | 110-160 | Run-level table: command-adapter startup failure (non-zero exit without WAVE_RESULT) maps to `fail-protocol` |

## Program Design

```js
// harness/adapters/agent/command.js
export const PREFLIGHT_PROMPT = 'Reply with the single word OK.';
export const PREFLIGHT_TIMEOUT_MS = 60_000;
/** @returns {Promise<{ ok: true } | { ok: false, error: string }>} */
export async function probeCommand({ cmd, repoRoot })
```

```
rad deliver (cli.js deliverCommand)
  ├─ gate check (unchanged)
  ├─ adapter selection
  │    └─ command branch: createCommandAdapter(...)
  │         └─ if RAD_AGENT_PREFLIGHT !== 'off' and no injected runWave:
  │              probeCommand({cmd, repoRoot})
  │                ok    → continue
  │                !ok   → stderr "rad deliver: RAD_AGENT_CMD failed to start ..." ; return 1
  ├─ worktree create (unchanged)
  └─ deliverSpine (unchanged)
        └─ runWave → runCommand
             non-zero exit, no WAVE_RESULT → { outcome:'fail-protocol', status:'failed', tasks }
             → matrix implement.fail-protocol = abort   (existing row)
```

No files are added, moved or deleted.

## Execution Notes

### Do Not Touch
- `harness/matrix.yaml`, `harness/matrix.js`: the existing `fail-protocol → abort` row already gives the no-retry behaviour, and the vocabulary is frozen.
- `harness/adapters/agent/contract.js`: `syntheticFailure` and `resultToOutcome` are shared with the SDK adapter. Classify inside `command.js`, following the existing hand-built terminal results there (truncation and no-WAVE_RESULT paths).
- `harness/spine.js`, `harness/events.js`, `harness/transitions.js`, `harness/gates.js`: no new event, reason or terminal kind.
- `ENV_ALLOW_LIST` contents and the #117 stdout-fallback message format.
- `harness/adapters/agent/sdk.js` (or equivalent SDK adapter).

### Key Files
- `harness/adapters/agent/command.js`: `ENV_ALLOW_LIST`, `buildChildEnv`, `spawnOnce`, and the `runCommand` failure branches (timeout, spawn error, truncation, non-zero exit + stdout fallback, no-WAVE_RESULT).
- `harness/adapters/agent/contract.js`: `syntheticFailure`, `resultToOutcome`, `toWaveResult`, `sanitizeErrorMessage`.
- `harness/cli.js`: `deliverCommand` adapter construction (the sdk and command branches) and the early-exit style `process.stderr.write('rad deliver: ...'); return 1;`.
- `harness/test/agent-adapters.test.js`: the `fakeCmd` / `withTempDir` fake-executable pattern and the save/restore of `process.env`.
- `harness/matrix.yaml`: confirms `implement.fail-protocol: abort`.

### Reminders
- The probe must use the *same* argv and env construction as a real wave. Factor the shared part rather than duplicating it, so the two can't drift.
- Error text always passes through `sanitizeErrorMessage` and the existing byte cap. Never log the prompt.
- The preflight costs one tiny model call per deliver on the command path. `RAD_AGENT_PREFLIGHT=off` is the documented escape hatch.
- Env-knob parsing: only the exact value `off` disables. Unset, empty and any other value run the probe (fail-closed toward checking).
- `.env.example` is not self-protected, but CLAUDE.md is the project's config document. Change only the Agent Adapter section.

## Wave Plan

### Wave 1 — sequential
Verify: npm test --prefix harness

Both tasks edit `command.js`, so they run in order.

#### Task 1.1: Classify startup failure as fail-protocol
File: harness/adapters/agent/command.js:198-240, harness/test/agent-adapters.test.js
What: In `runCommand`, when the process exits non-zero and stdout contains no `WAVE_RESULT` block, return `{ outcome: 'fail-protocol', status: 'failed', tasks: syntheticFailure(waveId, msg).tasks }`, where `msg` keeps #117's excerpt logic unchanged. Do the same for the spawn-error branch. A non-zero exit whose stdout *does* contain a `WAVE_RESULT` block keeps today's parse path. Update any #117 fallback test whose expected outcome changes from `fail-tests`, and add tests: a non-zero exit with empty output gives `fail-protocol`; an ENOENT spawn gives `fail-protocol`; a non-zero exit with a valid `WAVE_RESULT` parses as before. Add a spine-level test (real adapter plus a failing `fakeCmd`) proving the deliver stops after one attempt with `wave-failed {wave:1, action:'abort'}`.
Validate: AC#1, AC#2 — `npm test --prefix harness` passes, including the new cases.

#### Task 1.2: Export probeCommand
File: harness/adapters/agent/command.js:40-160, harness/test/agent-adapters.test.js
What: Add exported `PREFLIGHT_PROMPT`, `PREFLIGHT_TIMEOUT_MS` and `probeCommand({ cmd, repoRoot })`. Factor the argv/env construction shared with `runCommand` so both use one code path, and reuse `spawnOnce` (output cap, timeout). Resolve `{ ok: true }` on exit 0. Otherwise resolve `{ ok: false, error }` with a sanitized, capped excerpt: stderr first, falling back to stdout as in #117, and including the timeout case. Never throw for an agent failure. Tests use `fakeCmd`: exit 0 gives ok; exit 1 printing "Not logged in" to stdout gives `ok:false` with that text; a missing executable gives `ok:false`; the probe receives the probe prompt on stdin and the allow-listed env only (a fake echoing a sentinel env var set in the parent must not see it).
Validate: AC#3 — `npm test --prefix harness` passes, including the probe cases.

### Wave 2 — parallel
Depends on: Wave 1 complete
Verify: npm test --prefix harness

#### Task 2.1: Wire the preflight into rad deliver
File: harness/cli.js:460-500, harness/test/agent-adapters.test.js
What: In `deliverCommand`'s command branch, after `createCommandAdapter`, and only when no `ctx.runWave` is injected and `process.env.RAD_AGENT_PREFLIGHT !== 'off'`, await `probeCommand({ cmd, repoRoot })`. On `!ok`, write the AC#4 message and return 1 before worktree creation, `deliver-started` or any other event. Add `deliverCommand` tests with `fakeCmd`: a failing probe returns 1, prints the message and leaves the event log empty or unchanged; `RAD_AGENT_PREFLIGHT=off` skips the probe (so a first-wave failure is recorded instead); a passing probe proceeds; the sdk path never probes. Save and restore `process.env` as in the existing tests.
Validate: AC#4, AC#5, AC#7 — `npm test --prefix harness` passes, and the existing `deliver.test.js` cases pass unchanged.

#### Task 2.2: Document the env-less auth contract
File: CLAUDE.md, .env.example, docs/rad-cli.md, docs/rad-wave-contract.md
What: CLAUDE.md Agent Adapter: state that `RAD_AGENT_CMD` runs under an allow-listed env (name the variables) and must authenticate without inherited env vars (disk or OS keychain), describe the preflight and `RAD_AGENT_PREFLIGHT=off`, and point to #114's wrapper-script escape hatch for env-injected credentials. `.env.example`: a warning comment on the `claude -p` example, plus a commented `# RAD_AGENT_PREFLIGHT=off`. `docs/rad-cli.md`: the preflight message, when it runs, and the opt-out. `docs/rad-wave-contract.md`: split the run-level row so that, for the command adapter, a non-zero exit or spawn error with no `WAVE_RESULT` maps to `fail-protocol` (no retry), and state that the SDK adapter is unchanged.
Validate: AC#6 — each file states the contract, and the wave-contract table row matches Task 1.1's behaviour.

## Tests to Write
- [ ] Non-zero exit with no WAVE_RESULT and ENOENT spawn both yield fail-protocol; non-zero exit with a WAVE_RESULT parses as before — harness/test/agent-adapters.test.js
- [ ] Deliver with an agent that can never start stops after one attempt via matrix abort — harness/test/agent-adapters.test.js
- [ ] probeCommand ok on exit 0, not ok with excerpt on exit 1 or missing executable, env limited to the allow-list, probe prompt on stdin — harness/test/agent-adapters.test.js
- [ ] deliverCommand failing probe returns 1 with the message and no events; RAD_AGENT_PREFLIGHT=off skips; sdk path never probes — harness/test/agent-adapters.test.js

## Non-Goals
- A preflight or classification change for the SDK adapter.
- Widening `ENV_ALLOW_LIST` or adding any credential-passthrough variable.
- New event types, `wave-failed` reasons, spine terminals, or matrix rows.
- Parsing or validating the model's reply to the probe prompt.

## Out-of-Scope Dependencies
None. Every file is architect-writable.

## Risks
- **An extra model call per deliver.** The probe spends a few tokens and a few seconds. It is documented, and `RAD_AGENT_PREFLIGHT=off` disables it.
- **A legitimately failing agent that crashes mid-work without a WAVE_RESULT now aborts instead of retrying.** This matches the existing exit-0-no-WAVE_RESULT → `fail-protocol` rule, since a run with no protocol output is a protocol failure. A retry after a crash is lost; the operator re-runs after investigating.
- **#117's tests may assert `fail-tests` on the stdout-fallback path.** Those expectations change deliberately (AC#7), not by accident.
- **Vendor CLIs that reject stdin prompts, or that need a subcommand.** The probe uses exactly the configured command, so if it works for a wave, it works for the probe.

## Issue Gaps

- **Probe style: a real one-line prompt, not `--version`.** #114 suggested "a trivial no-op / `--version` probe", but `claude --version` succeeds while logged out, so it would miss the reported failure. This plan spends one tiny prompt instead. *Verify: acceptable cost, or would you rather have a configurable probe command?*
- **Default ON with an `off` opt-out.** Most RAD knobs are opt-in, but the preflight appends no events (event sequences stay byte-identical) and exists to catch misconfiguration an operator doesn't know they have. *Verify: or make it opt-in (`RAD_AGENT_PREFLIGHT=on`)?*
- **Classification rule: "non-zero exit and no WAVE_RESULT", not "first attempt with near-empty output".** #114 described startup failure as "non-zero with empty stdout on the first attempt". This plan uses a rule with no byte threshold or attempt dependence, matching the existing exit-0 rule. *Verify: agree that a mid-work crash without protocol output should abort, not retry?*
- **Command adapter only.** The SDK adapter keeps mapping run-level errors to `fail-tests`. *Verify: open a follow-up issue for SDK parity?*
- **The preflight lives in `cli.js`, not as a spine port.** That means no auditable event for a failed preflight. The trade-off: no new event or terminal kind, and nothing is written for a deliver that never started. *Verify: acceptable, or do you want a `wave-failed {reason:'agent-preflight'}` record?*
