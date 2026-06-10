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

## The adapter interface

An adapter is a factory that returns a `runWave` function:

```
runWave(wave, planCtx) -> Promise<{ outcome, status, tasks }>
```

- `wave` — the wave descriptor from the plan: `{ n, type, tasks: [...] }`.
- `planCtx` — orchestrator context: `{ feature, branch, executionLog,
  executionNotes: { doNotTouch, keyFiles, reminders }, acceptanceCriteria }`.

The returned result:

| Field | Type | Meaning |
|-------|------|---------|
| `outcome` | string | the **matrix outcome** the spine reads (`result.outcome`) |
| `status` | string | `complete` or `failed` — the wave-level roll-up |
| `tasks` | array | per-task records, for the execution log |

The spine only consumes `outcome`. It passes it to `resolveOutcome('implement',
outcome)` against `harness/matrix.yaml`. The matrix vocabulary is **fixed**:

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
- An unrecognized task `status` value is coerced to `complete`.
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

Run-level failures the adapter detects before/around parsing map directly:

| Run-level condition | Matrix outcome |
|---------------------|----------------|
| wall-clock timeout (deadline exceeded) | `fail-timeout` |
| missing `WAVE_RESULT` after one reprompt | `fail-protocol` |
| non-zero exit / spawn error / SDK error result | `fail-tests` (via synthetic failure) |

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
5. **Reconcile:** wrap the parsed result with `resultToOutcome` into
   `{ outcome, status, tasks }`.
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
