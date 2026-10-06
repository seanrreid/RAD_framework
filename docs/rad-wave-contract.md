# RAD Wave Contract

The **wave contract** is the provider-neutral interface between the RAD deliver
spine and whatever agent actually executes a wave. It is plain text — no vendor
SDK, no JSON-RPC, no proprietary message format — so any agent that can read a
prompt and emit a `WAVE_RESULT` block can drive a RAD delivery.

Three adapters ship today and all honor this contract:

- **`command`** (default, vendor-neutral) — shells out to an operator-configured
  CLI agent (`claude -p`, `codex exec`, `aider`, or a wrapper script).
- **`sdk`** (Anthropic) — drives the Claude Agent SDK `query` loop.
- **`acp`** (vendor-neutral) — speaks Agent Client Protocol v1 to an agent
  spawned from `RAD_AGENT_CMD`. ACP is only the transport: the prompt and the
  `WAVE_RESULT` block are the same plain text.

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

RAD ships three adapters, selected by `RAD_AGENT`: `command` (spawns any CLI
agent), `sdk` (the Claude Agent SDK) and `acp` (an Agent Client Protocol v1
agent; see [The `acp` adapter](#the-acp-adapter)). Each is a factory that
returns a `runWave` function:

```
runWave(wave, planCtx) -> Promise<{ outcome, status, tasks?, usage?, permissions? }>
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
| `usage` | `{ input, output, total, cacheRead?, cacheWrite?, cost? }` (numbers) | **optional and adapter-optional** — an adapter that observes no token counts omits the key entirely; within it, `cacheRead` / `cacheWrite` / `cost` are each **optional** and **absent** (never `0`, never `undefined`) when unreported | normalized token usage for the wave attempt, produced by `normalizeUsage`: `input` is the uncached input remainder, `cacheRead` the cache tokens read, `cacheWrite` the cache tokens written, `cost` the provider-reported spend (#121) |
| `permissions` | array of `{ kind, decision }` | **optional, `acp` only**; omitted when the agent made no permission request | each `session/request_permission` the acp adapter answered: `kind` is the ACP tool kind (or `null`), `decision` is `allow`, `reject` or `cancelled`. The spine copies a non-empty array onto the `wave-attempt` event; no fold reads it |

Both optional fields are **adapter-optional**: an adapter that reports neither
behaves exactly as one that predates them. A missing `usage` contributes `0` to
the `RAD_TOKEN_BUDGET` breaker (the spine reads `result.usage?.total ?? 0`), and
a missing `tasks` is simply nothing to record.

Each optional `usage` key (`cacheRead`, `cacheWrite`, `cost`) is set **only**
when its value is a finite, non-negative number; any other value (string, `NaN`,
`±Infinity`, negative) is **dropped** and the key is absent. A usage object with
no cache/cost data is byte-identical to the pre-#121 `{ input, output, total }`
shape, and cache/cost fields alone never make usage "usable" — without any of
`input` / `output` / `total` the whole `usage` key is omitted.

### The `RAD_USAGE` line (command adapter)

Most agent CLIs print no machine-readable token counts, so the command adapter
(`harness/adapters/agent/command.js`) omits `usage` by default. A wrapper that
does know its counts may print a single line on stdout:

```
RAD_USAGE {"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":800,"cost":0.012}
```

- **Format** — the literal token `RAD_USAGE`, whitespace, then one JSON object on
  the same line (matched as `^RAD_USAGE\s+(\{.*\})\s*$`, multiline, first
  match wins). It may appear anywhere in stdout, alongside the `WAVE_RESULT` block.
- **Accepted keys** — each normalized key accepts its camelCase name or a
  snake_case alias (the camelCase name wins when both are present):

  | Normalized key | Accepted keys |
  |---|---|
  | `input` | `input`, `input_tokens` |
  | `output` | `output`, `output_tokens` |
  | `total` | `total`, `total_tokens` (derived as `input + output` when absent) |
  | `cacheRead` | `cacheRead`, `cache_read_input_tokens` |
  | `cacheWrite` | `cacheWrite`, `cache_creation_input_tokens` |
  | `cost` | `cost` |

- **Invalid values are dropped** — per the rules above; unknown keys are ignored.
- **Malformed line** — unparseable JSON, or no usable `input` / `output` /
  `total`, is non-fatal: `usage` is omitted and the wave outcome is unaffected.

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

### Capabilities

Before any wave runs, `rad deliver` resolves every wave's capability classes
(#85; see [`configuration.md`](./configuration.md#capabilities)) and hands the
result to the adapter as `planCtx.waveEffective`: an object keyed by wave
number whose value is that wave's effective class list (e.g. `{ 2: ['fs_read'] }`).
It carries **constrained waves only**. A wave absent from it is unconstrained
and the adapter runs it with its own default — for the `sdk` adapter, exactly
today's `allowedTools`.

**Refuse, never over-grant.** An adapter that cannot enforce a wave's set must
cause a refusal **before launch** (exit 2, before any event is appended) — it
must never run the wave with more than the effective set. The `command` adapter
cannot narrow an agent CLI's tools, so deliver refuses any constrained wave
narrower than all five classes on it; the `acp` adapter is refused the same
way, because an ACP agent may act without asking permission; the `sdk` adapter
maps classes to tools and refuses `mcp`, which it cannot grant.

### The `acp` adapter

`harness/adapters/agent/acp.js` is a hand-written, zero-dependency ACP v1
client (Node built-ins only). It spawns `RAD_AGENT_CMD` with the same
allow-listed env as the `command` adapter (`buildChildEnv`), with the repo
root as its cwd, and speaks newline-delimited JSON-RPC 2.0 over the agent's
stdio. One process and one session per attempt. Why RAD speaks ACP, and what
it gives up, is in [`acp-evaluation.md`](./acp-evaluation.md).

**Command string.** Tokenized on whitespace like the `command` path, so a path
cannot contain spaces (use a wrapper script). A `{prompt}` token is rejected:
the prompt travels over the protocol. `{model}` is not substituted.

**Handshake.**

1. `initialize` with `protocolVersion: 1` and no client capabilities
   (`fs.readTextFile`, `fs.writeTextFile` and `terminal` all `false`). Any
   other `protocolVersion` in the answer is `fail-protocol`, before a prompt is
   sent. `authMethods` are not acted on: the agent must already be
   authenticated.
2. `session/new` with `cwd` = the repo root and `mcpServers: []`. A missing or
   empty `sessionId` is `fail-protocol`.

**Turn.** One `session/prompt` carrying `buildWavePrompt` as a single text
block. The `agent_message_chunk` text is collected and parsed with
`contract.js`, exactly as on the `command` path. If the turn has no
`WAVE_RESULT` block, RAD sends one reprompt in the same session; still none is
`fail-protocol`. Every agent request other than `session/request_permission`
(`fs/*`, `terminal/*`, anything else) is answered `-32601` (method not found).

**`stopReason` mapping.**

| `stopReason` | Result |
|--------------|--------|
| `end_turn`, `max_tokens`, `max_turn_requests` | the turn text goes through the normal `WAVE_RESULT` parse |
| `refusal` | `fail-scope` |
| `cancelled` after RAD's own timeout cancel | `fail-timeout` |
| `cancelled` RAD did not ask for, or any unknown value | `fail-protocol` |

**Timeout and failures.** At the wave deadline RAD sends `session/cancel`,
waits a grace period for the turn to settle, then SIGTERM and SIGKILL; the
attempt is `fail-timeout`. An agent crash, a line that is not JSON-RPC 2.0, a
response to an unknown id, or an error response is `fail-protocol`.

**Permission policy.** Each `session/request_permission` is answered from the
wave's effective capability classes (default `fs_read`, `fs_write`, `shell`):

| ACP tool `kind` | Capability class |
|-----------------|------------------|
| `read`, `search`, `think` | `fs_read` |
| `edit`, `delete`, `move` | `fs_write` |
| `execute` | `shell` |
| `fetch` | `net` |
| `other`, `switch_mode`, missing | none: always refused |

RAD selects the `allow_once` option when the class is in the effective set and
`reject_once` otherwise. If the wanted option is not offered it answers
`cancelled`. It never selects `allow_always` or `reject_always`. After RAD has
cancelled the turn, every permission request is answered `cancelled`. The
decisions are returned as `permissions` and recorded on the `wave-attempt`
event. They are defence in depth, not enforcement: an agent may run a tool
without asking, so a constrained wave is refused before launch (see
[Capabilities](#capabilities)).

**Usage.** Stable v1 `usage_update` carries only `used` and `size` (context
occupancy) and an optional `cost`, so a conformant agent's attempts carry no
`usage` and count as `0` toward `RAD_TOKEN_BUDGET`. If an agent sends the draft
`Usage` token fields (`inputTokens`, `outputTokens`, `totalTokens`,
`cachedReadTokens`, `cachedWriteTokens`), they are mapped through
`normalizeUsage`, with `cost` taken only when its currency is USD.

**Model.** ACP v1 has no stable model selector. An explicit `--model` or a
wave `Model:` line produces one warning per run
(`acp adapter: model '<id>' ignored; ...`) and the agent uses its own
configured model. Without either, nothing is printed.

**Preflight.** Before Wave 1, `rad deliver` runs the handshake only
(`initialize` and `session/new`, no prompt, so no model cost), under the same
`RAD_AGENT_PREFLIGHT` and `RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS` rules as the
`command` path. A failure exits 1 with
`RAD_AGENT_CMD failed the ACP handshake: <error>`.

To check an agent before using it, run `rad acp-check --cmd "<agent>"` (see
[`rad-cli.md`](./rad-cli.md#rad-acp-check)).

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

## Stop contract

Every `rad deliver` run ends in exactly one typed terminal. The classification
lives in `harness/stops.js` (`classifyStop`), which is pure and fail-closed: an
unknown `stopped` value, an unknown matrix action, or a malformed result
**throws** — there is no default class, so a new terminal must be added to the
table, never silently bucketed.

### Completion criteria

A run is **complete** only when the event log shows it: a `wave-complete` for
every plan wave **anywhere** in the history (counted as `resumeFrom` counts
them, so waves a prior run completed still count after a resume) **and** a
`pr-opened` after the latest `deliver-started`, so the current run itself
finished and opened the PR (the pure `deliverCompleted` fold). **The agent's claim is not evidence** — a
`WAVE_RESULT` saying `complete` only feeds the matrix; completion is read from
recorded events, never from the agent's text. A run whose spine returns without
that evidence exits `1` ("completion not evidenced").

### Evaluation rule

Every stop decision is evaluated over **observable state only** — the event log,
the plan doc and its fingerprint, and the exit codes of deterministic checks.
No stop is resolved by model judgment.

### Classification table

Two classes: `needs-decision` (a limit or policy a human can lift, or a
non-deterministic condition — a retry, a raised limit, or a re-approval may
succeed) and `failed` (a deterministic check showed the work is wrong for the
plan — re-running unchanged cannot succeed).

| `stopped` | Class | `reason` | Decision line |
|-----------|-------|----------|---------------|
| `matrix`, action `surface` | `needs-decision` | matrix outcome | `{wave}: {outcome} — non-deterministic failure (e.g. timeout/orphaned attempt); retry, raise the limit, or split the wave` |
| `matrix`, action `abort` | `failed` | matrix outcome | `{wave}: {outcome} — the work is wrong for the plan; fix the plan or the code and re-run` |
| `hook-veto` | per its action (`surface` / `abort`, as above) | matrix outcome | the matching matrix line + ` — vetoed by hook {hook} at {point}` |
| `doom-loop` | `failed` | `doom-loop` | `{wave} failed identically twice — a retry cannot fix it` |
| `budget` (maxAttempts) | `failed` | `budget` | `{wave} exhausted its attempts` |
| `post-check` | `failed` | `post-check` | `post-check {check} exited {status}` |
| `resume-verify` | `failed` | `resume-verify` | `resume verify: a test file promised by an already-completed wave is missing; restore it and re-run` |
| `token-budget` | `needs-decision` | `token-budget` | `token budget {budget} reached (spent {spent}); raise RAD_TOKEN_BUDGET or stop` |
| `failed-attempt-cap` | `needs-decision` | `failed-attempt-cap` | `{failed} failed attempts reached RAD_MAX_FAILED_ATTEMPTS={cap}; raise the cap, re-plan, or stop` |
| `approval-changed` | `needs-decision` | `approval-changed` | `the plan changed since approval (or approval no longer holds); re-approve before re-running` |
| `gate` (pre-start) | `needs-decision` | `gate` | `plan not approved; run /rad-approve` |

`{wave}` renders as `wave N` (or `the wave` when absent); any other absent
placeholder renders as `unknown`.

Every stop after `deliver-started` appends exactly one audit-only
`deliver-stopped` event `{ class, reason, decision, wave?, action?, outcome? }`.
Success appends none — success is `pr-opened`. A pre-start `gate` stop happens
before `deliver-started` and so records no event.

### Between-wave checks

After each successful wave, before the next one starts, the spine runs:

- **Approval re-check** — the gate fold plus the plan fingerprint compared to the
  approved one. A lapsed approval or an edited plan stops with `approval-changed`.
  An `approved` event recorded during a run (after its latest `deliver-started`)
  also stops it with `approval-changed` — checked before every wave and once more
  after the last wave, before post-checks. Re-approval happens between runs, never
  within one; the mid-run event stays in the log as evidence (#158).
- **Scope check** — `scripts/check-scope.sh`. A non-zero exit demotes the wave to
  `fail-scope`, which the matrix routes to `abort`.

The end-of-run post-checks are retained unchanged.

### `RAD_MAX_FAILED_ATTEMPTS`

Opt-in (positive integer). Counts cumulative non-success wave-attempts since the
latest `deliver-stopped`; reaching the cap stops with `failed-attempt-cap`. A
malformed value (non-numeric, zero, negative) exits `2` before any event is
appended. Unset = no cap.

### Resuming a stopped run

`rad deliver <feature> --resume --context "<text>"` re-runs a stopped feature with
the operator's decision attached (flags and the ordered eligibility table:
[`rad-cli.md`](./rad-cli.md#resuming-a-stopped-run)).

- **`needs-decision` only.** Only a run whose latest `deliver-stopped` is class
  `needs-decision` is resumable. A `failed` stop is refused (exit `2`) — re-running
  unchanged cannot succeed, so fix the plan or code and plain re-run.
- **Audit event.** The spine appends one audit-only `run-resumed` event right after
  `deliver-started`: `{ context, recordedBy, stop: { class, reason, wave? } }`, the
  context verbatim and `recordedBy` the running `git user.email`.
- **First `runWave` call only.** That call's prompt carries a
  `## Operator Context (resumed run)` block — the prior stop's class, reason, wave,
  and decision, plus the operator text verbatim in a collision-proof backtick
  fence — placed where a Prior Attempt Failure block goes (after `### Reminders`,
  before `## Guardrail Extensions`). Retries and later waves do not get it.
- **No gate bypass.** The pre-start approved gate and the between-wave approval and
  scope re-checks run unchanged; a refused pre-start gate appends no `run-resumed`.
  Resume grants no authority — anyone may resume.
- **Not a wave attempt.** `run-resumed` does not count toward
  `RAD_MAX_FAILED_ATTEMPTS` (the counter already resets at `deliver-stopped`).

Without `--resume` the event sequence and prompts are byte-for-byte unchanged.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | complete (evidenced by the `deliverCompleted` fold) |
| `1` | failed — including "completion not evidenced" |
| `2` | usage / config error |
| `3` | needs a human decision |

The stderr failure line carries `class=` and `decision=`.

### The harness never parks

`surface` is a **terminal return, not a pause** — the harness never waits for a
human mid-run. Attended vs unattended is the **caller's** concern: an unattended
caller (CI, a script) branches on the exit code; a `/rad-deliver` session is the
attended wrapper that relays the decision line to the operator. No attendedness
input exists in the harness.

---

## Writing a new adapter

**Preferred: speak ACP v1 and pass `rad acp-check`.** For a provider RAD does
not support yet, the first choice is no new adapter at all: run (or write) an
ACP v1 agent for it, use `RAD_AGENT=acp`, and check it with
`rad acp-check --cmd "<agent>"` (see [`rad-cli.md`](./rad-cli.md#rad-acp-check)).
Write a bespoke adapter only when the provider cannot speak ACP or needs
something ACP cannot carry, such as enforced capability classes.

A bespoke adapter follows the same skeleton as the shipped ones; reuse the
shared helpers in `contract.js` rather than reimplementing the protocol.

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
7. **Honor capabilities:** either map each class in `planCtx.waveEffective` to
   your agent's own tool controls, or add the adapter to the deliver-time
   refusal path (as `command` is) so a constrained wave is refused before
   launch — see [Capabilities](#capabilities).

### `command` vs `sdk` vs `acp`

| | `command` | `sdk` | `acp` |
|---|-----------|-------|-------|
| Transport | spawns an OS process, prompt on stdin (or `{prompt}` token) | Claude Agent SDK `query` async loop | spawns an OS process, ACP v1 JSON-RPC over stdio; `{prompt}` rejected |
| Credentials | **none** required by the adapter — the configured command owns them | requires `ANTHROPIC_API_KEY` | **none** required by the adapter; the agent must already be authenticated |
| Retries | timeout terminal; spawn/non-zero exit surfaced | `transient` retried with backoff | timeout terminal (`session/cancel`, then kill); protocol errors `fail-protocol` |
| Capabilities | constrained waves refused | mapped to `allowedTools`; `mcp` refused | constrained waves refused; permission requests answered and recorded |
| Model | `{model}` token in the command | `--model` / wave `Model:` | ignored with one warning |
| Usage | `RAD_USAGE` line, if printed | SDK token counts | none from a conformant v1 agent |
| Selection | `RAD_AGENT=command` (default) + `RAD_AGENT_CMD=<cmd>` | `RAD_AGENT=sdk` | `RAD_AGENT=acp` + `RAD_AGENT_CMD=<agent>` |

Selection is purely environment-driven (no config-file loader). See
[`rad-cli.md`](./rad-cli.md) for the `rad deliver` selection details and the
per-path credential requirements.
