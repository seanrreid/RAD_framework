# RAD Wave Contract

The **wave contract** is the provider-neutral interface between the RAD deliver
spine and whatever agent actually executes a wave. It is plain text — no vendor
SDK, no JSON-RPC, no proprietary message format — so any agent that can read a
prompt and emit a `WAVE_RESULT` block can drive a RAD delivery.

Two adapters ship today and both honor this contract:

- **`command`** (default, vendor-neutral) — shells out to an operator-configured
  CLI agent (`claude -p`, `codex exec`, `aider`, or a wrapper script).
- **`sdk`** (Anthropic) — drives the Claude Agent SDK `query` loop.

The contract lives in `harness/adapters/agent/contract.js` (pure, SDK-free). The
adapters live alongside it.

---

## Why waves: outcome-checkpointing vs context-fitting

Waves do two jobs at once, and only one of them is tied to today's model limits.
Separating them says what stays if a future model could hold a whole plan in one
context (tracked in [#46](https://github.com/seanrreid/RAD_framework/issues/46)).

**Permanent — outcome-checkpointing.** These are why RAD has waves at all:

- One recorded outcome per wave, resolved against the frozen 7-outcome matrix
  (`success | fail-tests | fail-scope | fail-protocol | fail-timeout | no-changes | abort-user`).
- Matrix stop conditions: a wave's outcome decides advance, revise, or surface,
  before the next wave starts.
- The token and attempt breakers (`RAD_TOKEN_BUDGET`, the retry budget), which
  are checked at wave boundaries.
- Resume from the last `wave-complete`, so an interrupted run restarts at a wave
  boundary rather than from scratch (see
  [Resuming interrupted execution](wave-execution.md#resuming-interrupted-execution):
  "the log is the checkpoint").
- Per-wave `Verify:` and `Model:` lines, which only make sense with a wave to
  attach them to.

**Depreciating — context-fitting.** These exist because a model's context is finite:

- The forced fresh agent context per wave
  (see [Parallel vs sequential](wave-execution.md#parallel-vs-sequential--what-it-actually-means)).
- Sizing each task to about 50% of a fresh context window
  (see [Writing good wave plans](wave-execution.md#writing-good-wave-plans)).

If a future model could run a whole plan in one context, only the forced reset
would become optional. Every permanent property above would still apply, one
wave at a time. [What waves are](wave-execution.md#what-waves-are) covers the
mechanics.

This section explains the design. It does not change any execution behaviour.

---

## The adapter interface

An adapter is a factory that returns a `runWave` function:

```
runWave(wave, planCtx) -> Promise<{ outcome, status, tasks?, usage? }>
```

- `wave` — the wave descriptor from the plan: `{ n, type, tasks: [...] }`.
- `planCtx` — orchestrator context: `{ feature, branch, executionLog,
  executionNotes: { doNotTouch, keyFiles, reminders }, acceptanceCriteria }`.

The returned result:

| Field | Type | Optionality | Meaning |
|-------|------|-------------|---------|
| `outcome` | string | **required** | the **matrix outcome** the spine reads (`result.outcome`) |
| `status` | string | **required** | `complete` or `failed` — the wave-level roll-up |
| `tasks` | array of `{ title, status, commit, concern, error }` | **optional** — present only when the agent reported at least one parseable task; otherwise the key is **omitted** | the per-task records parsed out of the `WAVE_RESULT` block, passed through for the execution log and for downstream event recording |
| `usage` | `{ input, output, total }` (numbers) | **optional and adapter-optional** — an adapter that observes no token counts omits the key entirely | normalized token usage for the wave attempt, produced by `normalizeUsage` |

Both optional fields are **adapter-optional**: an adapter that reports neither
behaves exactly as one that predates them. A missing `usage` contributes `0` to
the `RAD_TOKEN_BUDGET` breaker (the spine reads `result.usage?.total ?? 0`), and
a missing `tasks` is simply nothing to record.

A malformed, absent, or unparseable `tasks` block **degrades to omission of the
key** — it is never a thrown error, and it never by itself produces
`fail-protocol`. (An entirely missing or empty `WAVE_RESULT` block is a separate
condition and still maps to `fail-protocol` via `resultToOutcome`; see below.)

The spine only consumes `outcome` for control flow. It passes it to
`resolveOutcome('implement', outcome)` against `harness/matrix.yaml`. The matrix
vocabulary is **fixed**:

```
success | fail-tests | fail-scope | fail-protocol | fail-timeout | no-changes | abort-user
```

An adapter must only ever emit a string from this set.

---

## The wave prompt

`buildWavePrompt(wave, planCtx)` produces the prompt every adapter feeds its
agent. It is the same template the `/rad-deliver` prose command uses, containing:

- the wave number, feature, branch, execution-log path, and wave type;
- the Execution Notes (Do Not Touch / Key Files / Reminders);
- the guardrail-extension loading protocol;
- the acceptance criteria;
- one block per task (title, file(s), what, validate);
- the per-task workflow and the required return format.

The prompt instructs the agent to end its response with **exactly one**
`WAVE_RESULT` block and nothing after it.

---

## The WAVE_RESULT block (grammar)

The agent's response must contain a single block, delimited verbatim by the
literal lines `WAVE_RESULT` and `END_WAVE_RESULT`:

```
WAVE_RESULT
wave: <number>
status: [complete | failed]
tasks:
  - title: <task title>
    status: [complete | done_with_concerns | blocked_code | blocked_spec | blocked_intent]
    commit: [<hash> or —]
    concern: [<one-line concern if done_with_concerns, else —>]
    error: [<one-line summary if blocked_*, else —>]
  - title: ...
    ...
END_WAVE_RESULT
```

Grammar notes (enforced by `extractWaveResultBlock` + `parseWaveResult`):

- The block is extracted between the first `WAVE_RESULT` and the first
  `END_WAVE_RESULT`. Text outside the block is ignored.
- `status:` at the **top level** (no leading indent) is the wave status.
- Each task starts with `  - title:`; subsequent indented `status:`/`commit:`/
  `concern:`/`error:` lines belong to the current task.
- An unrecognized task `status` value is coerced to `blocked_code` (non-passing — it routes through `fail-tests`, never `success`; see `contract.js` and the `agent-contract.test.js` case).
- An unrecognized wave `status` value is coerced to `failed`.

The five valid task statuses are the RAD self-classification vocabulary:
`complete`, `done_with_concerns`, `blocked_code`, `blocked_spec`,
`blocked_intent`.

---

## Result → outcome mapping

`resultToOutcome(parsed)` reconciles a parsed `{ status, tasks }` into a matrix
outcome — it never invents an outcome outside the fixed set:

| Parsed result | Matrix outcome |
|---------------|----------------|
| no tasks / unparseable / empty block | `fail-protocol` |
| every task `complete` or `done_with_concerns` | `success` |
| any task `blocked_*` (or otherwise not passing) | `fail-tests` |

The mapping **collapses** the per-task statuses into a single outcome, but it
does not consume them: the individual `{ title, status }` records are **passed
through** onto the result as `tasks` alongside the collapsed `outcome`. The
outcome remains the only field that drives control flow; `tasks` preserves the
detail the collapse discards, so a caller can see *which* task blocked without
re-parsing the agent's text.

Run-level failures the adapter detects before/around parsing map directly:

| Run-level condition | Matrix outcome |
|---------------------|----------------|
| wall-clock timeout (deadline exceeded) | `fail-timeout` |
| missing `WAVE_RESULT` after one reprompt | `fail-protocol` |
| `command`: non-zero exit or spawn error with **no** `WAVE_RESULT` block | `fail-protocol` (matrix `abort` — no retry; a retry re-runs the same broken startup) |
| `command`: non-zero exit **with** a `WAVE_RESULT` block | `fail-tests` (via synthetic failure, as before) |
| `sdk`: SDK error result (unchanged) | `fail-tests` (via synthetic failure) |

---

## Writing a new adapter

Both shipped adapters follow the same skeleton; reuse the shared helpers in
`contract.js` rather than reimplementing the protocol.

1. **Build the prompt:** `buildWavePrompt(wave, planCtx)`.
2. **Run your agent once**, capturing its full text output. Apply a wall-clock
   deadline with `withTimeout(promise, timeoutMs, abortController)` — a timeout
   is terminal `fail-timeout`.
3. **Classify run failures** with `classifyError(err)` (`transient` |
   `permanent` | `model` | `resource`). The `sdk` adapter retries `transient`
   buckets with `backoffWithJitter(attempt)`; the `command` adapter treats a
   wall-clock timeout as terminal and surfaces other failures via
   `syntheticFailure`.
4. **Extract + parse:** `extractWaveResultBlock(text)` then
   `parseWaveResult(block)`. On a missing block, **reprompt exactly once** asking
   for the block; if still missing, return `fail-protocol`.
5. **Reconcile:** wrap the parsed result with `toWaveResult(parsed, usage)` — the
   shared builder that applies `resultToOutcome` and attaches the optional
   `tasks` / `usage` keys (omitting either when there is nothing to report).
6. **Never leak credentials:** run every surfaced error message through
   `sanitizeErrorMessage`, and hand your agent only an **allow-listed** env
   subset (`PATH`, `HOME`, locale/temp vars) — never spread the full
   `process.env`.

### `command` vs `sdk`

| | `command` | `sdk` |
|---|-----------|-------|
| Transport | spawns an OS process, prompt on stdin (or `{prompt}` token) | Claude Agent SDK `query` async loop |
| Credentials | **none** required by the adapter — the configured command owns them | requires `ANTHROPIC_API_KEY` |
| Retries | timeout terminal; spawn/non-zero exit surfaced | `transient` retried with backoff |
| Selection | `RAD_AGENT=command` (default) + `RAD_AGENT_CMD=<cmd>` | `RAD_AGENT=sdk` |

Selection is purely environment-driven (no config-file loader). See
[`rad-cli.md`](./rad-cli.md) for the `rad deliver` selection details and the
per-path credential requirements.
