# rad CLI

The `rad` CLI is a thin, deterministic composition layer over the harness ports.
It owns the pure mechanics that the `/rad-*` prose commands used to inline; the
prose commands retain the human-in-the-loop steps and shell out here for recording
and execution.

The CLI never calls a model on its own — `rad approve` is pure git/state work;
`rad deliver` delegates model calls to a selectable agent adapter (a spawned CLI
agent or the Claude Agent SDK) but does not call any API itself.

---

## Setup

The CLI lives in `harness/`. Install dependencies once:

```bash
cd harness
npm install
```

To use `rad` on your PATH without a path prefix:

```bash
cd harness
npm link        # makes `rad` available globally
```

Or invoke directly without linking:

```bash
node harness/cli.js <subcommand>
```

Tests use the `node harness/cli.js` form so they don't depend on a global link.

---

## Subcommands

### rad approve

```
rad approve <feature> [--on-behalf-of <name>] [--evidence <text>]
```

Records an architect approval:
- Appends an `approved` event to `.agents/state/<feature>/events.jsonl` — this
  event is the **sole approval authority**; the gate reads it, not the doc.
- Writes `Status: approved`, `Approved-By`, `Approved-At` headers to the plan doc.
  These headers are a **display-only mirror** of the event for humans skimming the
  plan; nothing gates on them.

The `/rad-approve` prose command calls this after the architect confirms.

**Authority:**
- Direct: the running `git user.email` must be a configured architect in `.rad/config.yml` (`roles.architect`)
- Proxy: `--on-behalf-of <name>` records an out-of-band approval; `--evidence` is
  required and captured in the event log

**Exit codes:** 0 on success, 1 on refusal or error.

---

### rad gate

```
rad gate <feature> <name> [--stdin]
```

A read-only query that answers "is gate `<name>` satisfied for `<feature>`?" by
folding `.agents/state/<feature>/events.jsonl`. It records nothing and mutates
nothing — it only reads the event log. For the `approved` gate this is the single
source of truth: the `approved` **event** is the sole approval authority, and the
plan doc's `Status:` header is a display-only mirror that the gate ignores.

`/rad-deliver` uses `rad gate <feature> approved` to decide whether wave execution
may start; `check-plan-approved.sh` shells out to it as well.

- `--stdin` reads the event log from standard input instead of the on-disk file,
  for piping or testing against an event stream that is not yet committed.

**Exit codes:** `0` when the gate is satisfied, non-zero when it is not. The query
**fails closed** — a missing, empty, or unreadable event log is treated as "not
satisfied" (non-zero), never as a pass.

---

### rad stop-status

```
rad stop-status <feature> [--stdin]
```

A read-only query that answers "is `<feature>` parked on a stop a human can
lift?" by folding the event log through `dormantStop` (`harness/events.js`). A run
is **dormant** when its latest `deliver-stopped` is class `needs-decision` **and** no
`deliver-started` follows it. Prints exactly one line and records nothing:

```
dormant class=needs-decision reason=<reason> wave=<wave|unknown> decision="<decision>"
none
```

`scripts/rad-status.sh` (and `/kickoff`) use it for the **Dormant Runs (needs a
decision)** section, with a `rad deliver <feature> --resume --context "..."` hint.

- `--stdin` reads a JSONL event log from standard input instead of the on-disk file.

**Exit codes:** `0` with either line, `1` on a malformed log or read error, `2`
on bad arguments.

---

### rad forecast

```
rad forecast <plan>
```

A read-only, **advisory** plan-time readout: "have the files this plan touches
been hard for agents before?" It resolves the plan's declared paths with
`plan_scope_paths` (`scripts/lib/plan-paths.sh` — the same Files-in-Scope +
per-task `File:` union the plan lint uses), builds the task→file mapping from
`.agents/plans/*.md` (parser in `harness/plan-tasks.js`), folds every
`.agents/state/*/events.jsonl`, and looks each path up in the `fileDeficitSignals`
fold (`harness/events.js`). The three deficits (`opaqueAbstraction`,
`missingDocumentation`, `insufficientTesting`) are proxies, each floored at 2
distinct features — see
[Prompt surfaces as a feedback-loop target](harness-and-framework.md#prompt-surfaces-as-a-feedback-loop-target)
for what each one measures. It records nothing and never blocks.

One line per deficit present on a declared path, then a summary:

```
forecast: <path> — <deficit> in <n> feature(s) (<feature>, ...); consider <remedy>
forecast: <k> of <n> path(s) have reliability signals (history: <m> feature(s)); advisory only — these are proxies, not verdicts
forecast: no reliability signals for <n> path(s) (history: <m> feature(s))
```

The remedy is described, never applied — a boundary/decomposition note, a comment
explaining the governing constraint, or a characterization test. `/rad-plan`
(Step 4b) and `/rad-adopt` (Step 6b) run it after the plan lint so the author can
fold a remedy task into the plan before approval. v1 is path-level only: no
wave-size or token-spend forecasting.

**Exit codes:** `0` on any readout (with or without signals), `1` on a malformed
event log (the message names the feature), `2` on bad arguments, an unreadable
plan, or a `plan_scope_paths` failure.

---

### rad digest

```
rad digest <feature> [--branch <ref>] [--base <ref>]
```

A read-only, ranked **review digest** for a feature's deliver PR — the Gate 2
first read: "where should the architect look?" It records nothing, calls no
model, opens no PR, and never blocks. `--branch` defaults to the plan's `Branch:`
header; `--base` defaults to `scripts/get-default-branch.sh`.

It folds, read-only, from `harness/digest.js`:

- **scope** — `scripts/check-scope.sh` over the branch vs base diff
- **approval** — the plan fingerprint and gate against the feature's event log
- **high-risk / waivers** — `plan_high_risk_findings` (`scripts/lib/plan-paths.sh`)
  plus the waivers frozen into the `approved` event
- **self-protected paths** — RAD's own machinery touched by the diff
- **deficit forecast** — the `fileDeficitSignals` fold (as `rad forecast`)
- **finding recurrence** — `.agents/findings.jsonl` per in-scope file
- **run evidence** — retries, non-success outcomes, the latest stop, and
  whether completion is evidenced for every declared wave

A failing source becomes an explicit **unavailable** input for that input only —
never dropped, never fatal to the rest of the digest.

**Ranking** (highest first): scope violations > approval not intact > un-waived
high-risk > waived high-risk (with its frozen justification) > self-protected
paths > deficit forecast > finding recurrence > run evidence.

**Output** is markdown:

```
## Review digest — <feature>

### Look here
- **<kind>** `<path>` — <detail>        (ranked; or "nothing flagged …")

### Evidence
- ✓|✗ <check> — <detail>
- unavailable: <input> — <reason>
```

**Readers:** `/rad-review` Step 1b (the `### Digest` section, ahead of Scope) and
the CI `deliver-integrity` job, which appends it to the job summary (a digest
failure there is a `::warning::`, never a failed job).

**Note:** a feature delivered through the `/rad-deliver` skill (not `rad
deliver`) has no spine wave events, so the digest shows `completion not
evidenced for <n> wave(s)` for it. This is deliberate — the digest is
recall-oriented and does not suppress it; confirm completion from the execution
log instead.

**Exit codes:** `0` on any digest (including ones with unavailable inputs), `1`
on a malformed event log or a `get-default-branch.sh` failure, `2` on bad
arguments, an invalid feature name, or an unreadable plan.

---

### rad review

```
rad review <reviewer> [--base <ref>]
```

Runs one reviewer agent (`.claude/agents/<reviewer>.md`) through a CLI you
choose — typically a **different vendor's** agent than the one that wrote the
code — and prints its output. It records no events, opens no PR, and has no
effect on `rad deliver`. `--base` defaults to `scripts/get-default-branch.sh`
(falling back to `main`); the prompt asks the reviewer to inspect
`git diff <base>...HEAD`.

**Resolution order.** The command is the first non-empty of
`RAD_REVIEW_AGENT_CMD`, then `RAD_AGENT_CMD`. Neither set → exit 2. The agent
file is read relative to the RAD checkout that holds `harness/cli.js` (not the
current directory), and the command runs there.

**Env allow-list.** The command runs under the same allow-listed env as the
`rad deliver` command adapter — only `PATH HOME LANG LC_ALL TMPDIR TERM USER` —
so the CLI must authenticate from on-disk config or the OS keychain. Exported
tokens (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) are **not** forwarded; use a
wrapper script if the CLI needs one. The prompt goes on stdin, unless the command
contains a `{prompt}` token, which is replaced by the prompt as a single argv
element.

**Output.** The agent's stdout is printed verbatim. One summary line goes to
stderr, naming the winning env var and only the executable's basename — never
the full command string:

```
rad review: reviewer=<reviewer> agent=<RAD_REVIEW_AGENT_CMD|RAD_AGENT_CMD> executable=<basename> findings=<n|none>
```

**Exit codes:** `0` when the output carries a parseable ` ```rad-findings `
block; `1` when the command failed (non-zero exit, spawn error, timeout) or
printed no parseable block; `2` on bad arguments, an unreadable reviewer file,
no configured command, or a malformed timeout.

**Timeout.** `RAD_REVIEW_TIMEOUT_SECONDS` (default **600**) is the wall-clock
ceiling. A malformed value (non-numeric, zero, negative) exits **2** rather than
falling back to the default.

**How `/rad-review` uses it.** When `RAD_REVIEW_AGENT_CMD` is set, `/rad-review`
Steps 4 and 4b run `rad review quality-reviewer` / `rad review
accessibility-reviewer` instead of the in-session sub-agents, take stdout as the
reviewer's output (its `rad-findings` block is persisted to
`.agents/findings.jsonl` as usual), and note a non-zero exit in the report
without stopping. The cycle record gains `review_agent: {source, executable}`
(the basename only). Unset → the sub-agents run as before. `RAD_AGENT_CMD`
alone does **not** switch `/rad-review` over; only `RAD_REVIEW_AGENT_CMD` does.

**Caveat.** A reviewer from a different vendor than the implementer reduces
*correlated* blind spots (the same model rarely catches its own habitual
mistakes), but it is not a correctness guarantee — a second model can miss what
the first missed, or flag false alarms. Treat its findings like any reviewer's.

This is **not** the same as `RAD_REVIEW_EVAL_CMD` (see [`evals.md`](./evals.md)),
which scores reviewer prompts against fixtures; `RAD_REVIEW_AGENT_CMD` runs a
real review of the current branch.

#### Provider cookbook

Each command must be logged in beforehand under your own account (it gets no
exported tokens). "Verified" means a smoke run of `rad review quality-reviewer
--base main` against a scratch repo whose branch adds a hardcoded API key exited
**0** with **≥1** finding.

| Agent | `RAD_REVIEW_AGENT_CMD` | Prompt delivery | Notes | Verified |
|-------|------------------------|-----------------|-------|----------|
| Claude Code | `claude -p` | stdin | Log in once with `claude` interactively. | 2026-09-30 — exit 0, 2 findings |
| Codex | `codex exec` | stdin (`codex exec` reads the prompt from stdin when no argument is given) | Log in with `codex login`. Runs in its default sandbox; review only reads. | 2026-09-30 — exit 0, 1 finding |
| opencode | `opencode run {prompt}` | argv (`{prompt}`) | `opencode run` is the non-interactive mode; add `-m provider/model` to pick a model. Configure credentials with `opencode auth` (alias of `opencode providers`). | 2026-09-30 — exit 0, 1 finding |
| aider | `aider --message {prompt}` | argv (`{prompt}`) | Needs provider credentials on disk (e.g. `.aider.conf.yml`), not exported keys. | no — aider not installed on the test machine |
| Flue | `npx flue run src/agents/<name>.ts -m {prompt}` | argv (`{prompt}`) | Requires a Flue project defining the reviewer agent. | no — needs a Flue project |

---

### rad deliver

```
rad deliver <feature> [--model <model-id>] [--resume --context <text>]
```

Drives wave execution for an approved plan. Reads the plan file, constructs
per-wave prompts, selects an **agent adapter** (see below), calls `deliverSpine`
with the adapter's `runWave`, and streams wave output to stdout. The plan must be
in `Status: approved` on its `rad/<feature>` branch tip.

#### Adapter selection

The runner is chosen by environment variable — there is no config-file loader.

| Env var | Values | Default | Meaning |
|---------|--------|---------|---------|
| `RAD_AGENT` | `command` \| `sdk` \| `acp` | `command` | which adapter drives the wave |
| `RAD_AGENT_CMD` | any command string | — | the CLI to spawn (command and acp paths) |
| `RAD_AGENT_PREFLIGHT` | `off` | — (probe runs) | exactly `off` skips the command- and acp-path startup preflight |
| `RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS` | positive integer | `60` | preflight probe deadline; malformed exits 2 |
| `RAD_TOKEN_BUDGET` | positive integer | — | per-deliver cumulative token ceiling (cost breaker) |
| `RAD_REVIEW_AGENT_CMD` | any command string | — (falls back to `RAD_AGENT_CMD`) | review-lane CLI for [`rad review`](#rad-review) and `/rad-review`; not used by `rad deliver` |

**Per-path credential requirements:**

- **`command` (default)** — requires **no** `ANTHROPIC_API_KEY`. Credentials are
  the configured command's concern. `RAD_AGENT_CMD` **is required**; if unset,
  `rad deliver` exits 1 with `RAD_AGENT_CMD is required when RAD_AGENT=command`.
- **`sdk`** — requires `ANTHROPIC_API_KEY`. If unset, `rad deliver` exits 1 with
  `ANTHROPIC_API_KEY is required`.
- **`acp`** — requires **no** `ANTHROPIC_API_KEY`; the ACP agent must already
  be authenticated (RAD does not run ACP `authenticate`). `RAD_AGENT_CMD` **is
  required**; if unset, `rad deliver` exits 1 with
  `RAD_AGENT_CMD is required when RAD_AGENT=acp`. A `{prompt}` token in it exits
  1 before any event is appended: the prompt travels over the protocol.

An unrecognized `RAD_AGENT` value exits 1 with
`unknown RAD_AGENT '<value>' (expected command | sdk | acp)`.

**Command-path env and startup preflight.** The command adapter hands
`RAD_AGENT_CMD` only an allow-listed env (`PATH`, `HOME`, `LANG`, `LC_ALL`,
`TMPDIR`, `TERM`, `USER`), and the acp adapter spawns it under the same env, so
the CLI must authenticate **without inherited env
vars** — on-disk credentials or the OS keychain, not an exported token. To catch
a CLI that is not logged in *before* any work starts, `rad deliver` runs a
**preflight** on the command path, after the approval gate and before
`deliver-started` or any event append (in worktree mode it runs inside the new
worktree, which is preserved if the probe fails): it spawns `RAD_AGENT_CMD` once
under that same env with a one-line prompt (one tiny model call per deliver). A
non-zero exit, spawn error, or timeout exits 1 with:

```
rad deliver: RAD_AGENT_CMD failed to start under the adapter env (it must authenticate without inherited env vars): <error>
```

`<error>` is a sanitized, capped excerpt of the CLI's output.

On the **acp** path the preflight is the ACP handshake only: `initialize` and
`session/new`, with no prompt, so it costs no model call. The same
`RAD_AGENT_PREFLIGHT` and `RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS` rules apply. A
failure (an agent that cannot start, speaks another `protocolVersion`, or
returns no session) exits 1 with:

```
rad deliver: RAD_AGENT_CMD failed the ACP handshake: <error>
```

The preflight is
skipped when `RAD_AGENT=sdk` or a `runWave` is injected (tests), and when
`RAD_AGENT_PREFLIGHT` is **exactly** `off` — unset, empty, or any other value
runs it. If your agent needs an env-injected credential, set `RAD_AGENT_CMD` to a
wrapper script that loads the secret itself and execs the agent; the allow-list
is deliberately not widened.

`RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS` sets the probe deadline in whole seconds
(default **60**). A malformed value (non-numeric, zero, negative) is a hard error:
`rad deliver` exits **2** with `RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS must be a
positive integer` rather than silently falling back to the default. It is not
validated when `RAD_AGENT_PREFLIGHT=off`, since no probe runs. A probe that
exceeds the deadline is killed and reported as an `agent preflight` timeout.

```bash
# Default (command) path — bring your own agent CLI, no API key needed here:
export RAD_AGENT=command            # (or leave unset)
export RAD_AGENT_CMD="claude -p"    # or "codex exec", "aider", a wrapper script
node harness/cli.js deliver my-feature

# SDK path — Anthropic SDK, API key required:
export RAD_AGENT=sdk
export ANTHROPIC_API_KEY=sk-ant-...
node harness/cli.js deliver my-feature

# ACP path — any Agent Client Protocol v1 agent, no API key needed here:
export RAD_AGENT=acp
export RAD_AGENT_CMD="gemini --acp"  # see the ACP recipes below
node harness/cli.js deliver my-feature
```

See [`rad-wave-contract.md`](./rad-wave-contract.md) for the provider-neutral
wave contract all three adapters honor, and
[The `acp` adapter](./rad-wave-contract.md#the-acp-adapter) for the handshake,
`stopReason` mapping and permission policy.

**Model:** `--model` defaults to `claude-opus-4-8` and applies to the **`sdk`**
path only (the `command` path's model is the configured command's concern):

```bash
RAD_AGENT=sdk node harness/cli.js deliver my-feature --model claude-sonnet-4-6
```

On the **acp** path no model is sent (ACP v1 has no stable model selector). An
explicit `--model` or a wave `Model:` line prints one warning per run and the
agent uses the model in its own config; the default `--model` is not passed, so
it never warns.

#### ACP recipes

Deliver-side `RAD_AGENT_CMD` values for `RAD_AGENT=acp`. Each agent must be
logged in beforehand under your own account: it gets only the allow-listed env,
so exported tokens (`OPENAI_API_KEY`, `GEMINI_API_KEY` and the like) do not
reach it. The command is split on whitespace, so it cannot contain `{prompt}`
and its paths cannot contain spaces; use a wrapper script otherwise. Constrained
waves are refused on acp, as on `command`.

| Agent | `RAD_AGENT_CMD` | Source | Notes | Verified |
|-------|-----------------|--------|-------|----------|
| Claude Code (`claude-agent-acp`) | `npx -y @agentclientprotocol/claude-agent-acp` | the package's `bin` (`claude-agent-acp`) in [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp); the README gives install steps but no run command | Built on the Claude Agent SDK. Log in with `claude` interactively first. | no — not yet run against `rad acp-check` |
| Codex (`codex-acp`) | `npx -y @agentclientprotocol/codex-acp` | [codex-acp README](https://github.com/agentclientprotocol/codex-acp) | The README lists ChatGPT login, `CODEX_API_KEY`/`OPENAI_API_KEY` and a gateway; only an on-disk login can work here, since RAD forwards no keys and does not call `authenticate`. | no — not yet run against `rad acp-check` |
| Gemini CLI | `gemini --acp` | [Gemini CLI ACP mode](https://geminicli.com/docs/cli/acp-mode/) | Log in with `gemini` interactively first. | no — not yet run against `rad acp-check` |

**Marking a recipe verified.** With the agent logged in, run from the repo root:

```bash
node harness/cli.js acp-check --cmd "<RAD_AGENT_CMD>"
```

If it prints `rad acp-check: ok, 6 of 6 checks passed`, put the date and the
result (for example `2026-10-06 — 6 of 6 checks passed`) in the Verified
column. Never mark a row verified without running it; a failure goes in the
column as the first `FAIL` line. See [rad acp-check](#rad-acp-check).

**Exit codes:**

| Code | Meaning |
|------|---------|
| `0` | complete (evidenced by the `deliverCompleted` fold) |
| `1` | failed — credential/selection or preflight failure, a `failed` stop, or completion not evidenced (an unknown option or missing feature also exits `1`) |
| `2` | usage / config error — every `--resume` refusal (including `--context` with no value), malformed `RAD_MAX_FAILED_ATTEMPTS` / `RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS` |
| `3` | needs a human decision — a `needs-decision` stop (see [Resuming a stopped run](#resuming-a-stopped-run)) |

See the Stop contract in [`rad-wave-contract.md`](./rad-wave-contract.md#stop-contract)
for the stop classes behind `1` and `3`.

#### Resuming a stopped run

A run that stopped with class `needs-decision` (exit `3` — `token-budget`,
`failed-attempt-cap`, `approval-changed`, or a matrix/hook-veto `surface`) can be
re-run with the operator's decision attached:

```bash
node harness/cli.js deliver my-feature --resume --context "Raised the budget; wave 2 timed out on a flaky network call — retry as-is."
```

The context (at most **8000** characters, recorded verbatim) is appended as an
audit-only `run-resumed` event right after `deliver-started`, with `recordedBy`
(the running `git user.email`) and the prior stop, and is rendered into the
**first** wave prompt only. Resume grants no authority: anyone may run it, and the
approved gate plus the between-wave approval and scope re-checks run unchanged.
A `failed` stop is not resumable — fix the plan or code and plain re-run. Without
`--resume`, the event sequence and prompts are byte-for-byte unchanged.

Eligibility is checked in this order, **before** any event is appended or any
worktree is created. Every refusal prints `rad deliver: <reason>` and exits **2**:

| # | Condition | Refusal |
|---|-----------|---------|
| 1 | `--context` given no value | `--context requires a value` |
| 2 | `--context` without `--resume` | `--context requires --resume` |
| 3 | `--resume` without `--context` | `--resume requires --context "<text>"` |
| 4 | empty / whitespace-only context | `--context must not be empty` |
| 5 | context over 8000 characters (rejected, never truncated) | `--context exceeds 8000 characters (<n>)` |
| 6 | event log unreadable (worktree mode: the branch-tip log) | `cannot read the event log to resume: <error>` |
| 7 | no `deliver-stopped` in history | `nothing to resume: <feature> has no deliver-stopped event` |
| 8 | latest stop is class `failed` | `cannot resume a failed stop (<reason>): <decision>` |
| 9 | `git user.email` unresolvable | `cannot resolve git user.email for run-resumed.recordedBy` |

History is read from the same source the approved gate reads: the feature's log
in the main checkout, or `git show <branch>:.agents/state/<feature>/events.jsonl`
when `RAD_WORKTREE` is set. `rad stop-status <feature>` shows whether a run is
resumable. See [`rad-wave-contract.md`](./rad-wave-contract.md#resuming-a-stopped-run)
for the prompt block and cap interaction.

#### Cost & frugality (optional)

Two optional, fully backward-compatible knobs keep a deliver from over-spending.
Both are *opt-in*: absent, the spine behaves exactly as before.

- **`RAD_TOKEN_BUDGET`** — a per-deliver cumulative token ceiling. When set to a
  positive integer, the spine sums each wave's recorded `usage.total` and, **before
  starting the next wave**, gracefully stops if the running total has reached or
  exceeded the budget. The stop is a normal structured terminal — not a throw:
  `rad deliver` exits 1 and prints `stopped=token-budget spent=<n> budget=<n>`, and a
  `wave-failed` event with `reason: token-budget` is recorded. Unset, `0`, or
  non-numeric values leave the breaker disabled (no behavior change). Waves whose
  adapter emits no usage contribute `0`, so the breaker never trips spuriously.

  ```bash
  RAD_TOKEN_BUDGET=200000 RAD_AGENT=sdk node harness/cli.js deliver my-feature
  ```

- **Per-wave `Model:` (plan schema)** — a plan may tier its waves onto cheaper
  models. Inside a `### Wave N` block, an optional `Model:` line selects the model
  for that wave only:

  ```markdown
  ### Wave 1
  Model: claude-haiku-4-5    # cheap scaffolding wave

  ### Wave 2
  Model: claude-opus-4-8     # the wave that needs the strong model
  ```

  Waves without a `Model:` line fall back to the deliver default (`--model`, or
  `claude-opus-4-8`). The override is honored by both the `sdk` adapter and the
  `command` adapter when its `RAD_AGENT_CMD` template contains a `{model}` token.

  The wave prompt also carries a standing frugality reminder ("Truncate large
  file/command outputs — do not paste entire files or long logs") so each wave
  agent keeps its own context lean.

#### Worktree isolation (default)

**Breaking default (#61):** `rad deliver` now isolates every run into a git
worktree. Opt out with `RAD_WORKTREE=0` — the only value that turns it off.
Unset, empty, or any other value keeps isolation ON, so a typo cannot silently
disable it. With `RAD_WORKTREE=0`, `rad deliver` behaves as before: it runs in the
main checkout, constructs no worktree port, and binds every `check-*.sh` /
`open-pr.sh` to the repo root.

- **`RAD_WORKTREE`** — exactly `0` opts out; unset/empty/anything else = isolated.
- **`RAD_WORKTREE_DIR`** — optional base directory for the isolated tree. When
  set, the worktree lands at `$RAD_WORKTREE_DIR/<feature>`; otherwise it defaults
  to `../<repo-basename>-rad-worktrees/<feature>` (a sibling of the main checkout).

| variable | values | default | effect |
| --- | --- | --- | --- |
| `RAD_WORKTREE` | `0` to opt out | — (ON) | isolate the deliver run into a git worktree |
| `RAD_WORKTREE_DIR` | a directory path | sibling `../<repo>-rad-worktrees/<feature>` | base dir for the isolated tree |

This applies to the `rad deliver` CLI only. The `/rad-deliver` skill path is
unchanged — it runs wave sub-agents in the checkout it is invoked from. Both the
`RAD_WORKTREE=0` opt-out and the skill path are recorded as unguarded bypasses of
the `deliver-runs-isolated` registry invariant.

**Lifecycle.** The run moves through a **create → active →
complete/preserve** lifecycle:

1. **create** — `git worktree add` checks out the work branch into the isolated
   dir, and a `.rad-worktree.json` marker is written at its root (`status:
   "active"`). The spine's scripts then run against this isolated tree.
2. **complete (on success)** — when the spine finishes cleanly, the marker is
   cleared and `git worktree remove` tears the worktree down.
3. **preserve (on failure)** — when the spine stops on any terminal (gate,
   doom-loop, post-check, token-budget) or throws, the worktree is **kept** and
   its marker is rewritten to `status: "preserved"` so you can inspect the
   isolated tree. The structured failure line surfaces its path as
   `worktree=<dir>`.

**The marker is a safety interlock.** `remove`/`preserve` refuse to act on any
directory that does not carry a valid `.rad-worktree.json` marker for the named
feature. This prevents ever deleting the main checkout or an unrelated worktree.
The marker stays local and uncommitted (it records execution-environment state,
never delivery outcomes).

**Everything is read from the work branch.** In worktree mode the approved gate,
the plan doc, and the event log come from the work branch
(`$RAD_BRANCH_PREFIX<feature>`, default `rad/<feature>`), never from the main
checkout — so a Lane B plan, whose plan doc and approval exist only on the work
branch, delivers under isolation:

1. **gate** — the approved gate is evaluated over the branch tip's log
   (`git show <branch>:.agents/state/<feature>/events.jsonl`, the same fold as
   `rad gate --stdin`). An unapproved tip, or a log absent at the tip, fails closed
   with `gate not passed` (exit 1) **before any worktree is created**.
2. **create** — the worktree is created on that branch.
3. **rooted run** — the plan read, the state store (events read **and written**),
   the agent (and its preflight), and every spine script run are rooted at the
   worktree. Events land in the worktree, i.e. on the work branch; the main tree
   is left unmodified. A setup failure after create (e.g. no plan doc on the
   branch, failed preflight) preserves the worktree.

**Work branch checked out in the main checkout.** Git cannot check out a branch
that is already checked out elsewhere, so before creating the worktree
`rad deliver` resolves where the work branch is checked out:

- **main checkout, clean** — `rad deliver` switches the main checkout to the
  default branch, prints a notice, and continues.
- **main checkout, dirty** — exit 2 with the exact commands to run (commit or
  stash your changes, then `git checkout <default>`). Nothing is stashed or
  discarded for you.
- **another worktree** — exit 2; find it with `git worktree list`.

If `git worktree add` itself fails, the run fails (exit 1, `worktree create
failed`) — it never falls back to the main checkout. A preserved tree (failure or
stop) prints its path and the cleanup command:

```bash
scripts/worktree-lifecycle.sh remove <feature> <dir>
```

```bash
node harness/cli.js deliver my-feature                                # isolated (default)
RAD_WORKTREE_DIR=/tmp/rad-trees node harness/cli.js deliver my-feature
RAD_WORKTREE=0 node harness/cli.js deliver my-feature                 # opt out: main checkout
```

---

### rad acp-check

```
rad acp-check --cmd "<agent>" [--timeout <seconds>]
```

Runs the ACP v1 conformance check against one agent command, through the same
handshake and turn code the acp adapter uses. The command is tokenized like
`RAD_AGENT_CMD` (whitespace split, `{prompt}` rejected), spawned under the same
allow-listed env, with the repo root as its cwd. It sends one fixed prompt that
asks for a one-task `WAVE_RESULT` block, and answers any permission request
with the default capability set (`fs_read`, `fs_write`, `shell`). It writes no
events and no files, and it is not part of CI: it needs a logged-in agent.

The checks run in order and stop at the first failure:

| Check | Passes when |
|-------|-------------|
| `spawn` | the command parses and the process starts |
| `initialize` | the agent answers `protocolVersion` 1 |
| `session/new` | the agent returns a `sessionId` |
| `prompt` | the `session/prompt` turn ends with `stopReason` `end_turn`, `max_tokens` or `max_turn_requests` |
| `wave-result` | the turn text holds a `WAVE_RESULT` block that maps to the `success` outcome |
| `shutdown` | after stdin closes, the agent exits within 5 seconds without SIGTERM or SIGKILL |

`shutdown` runs only when the first five pass. Unlike a wave, the check sends
no reprompt: a turn without the block fails `wave-result`.

**Output.** One line per check run, `PASS <name>` or `FAIL <name>: <detail>`,
then a summary line:

```
PASS spawn
PASS initialize
FAIL session/new: agent returned no sessionId from session/new
rad acp-check: failed, 2 of 6 checks passed
```

A full pass ends with `rad acp-check: ok, 6 of 6 checks passed`.

`--timeout` bounds the whole check, in whole seconds (default **600**, the wave
timeout). A check still running at the deadline fails with a timeout detail.

**Exit codes:** `0` every check passed; `1` a check failed; `2` bad arguments:
a missing `--cmd`, a flag without a value, an unknown flag, a stray argument, a
repeated flag, or a `--timeout` that is not a positive integer.

---

## Install commands

The installer (`install.sh`) drives these verbs; they can also be run by hand.
All three work on `.rad/installed.json`, where each tracked file carries its
layer (`core` or `preset`) and SHA-256. `--target` defaults to the CLI's repo
root. See [INSTALL.md](../INSTALL.md#presets) and
[UPGRADE.md](../UPGRADE.md#how-upgrades-handle-local-edits) for the full rules.

### rad install-core

```
rad install-core --source <rad-clone> [--target <dir>]
```

Installs or upgrades the core framework files from a RAD checkout and writes
`.rad/installed.json`. An unmodified or absent file is written; a locally edited
file is kept and the new version staged under `.rad/upgrade-pending/`; a locally
deleted file is not restored.

**Exit codes:** `0` all written; `1` a file was kept or deleted; `2` nothing
written: bad arguments, a `--source` that is not a RAD source, a malformed
manifest, or a core path another layer owns.

---

### rad install-status

```
rad install-status [--target <dir>]
```

A read-only drift report. When a preset is recorded it prints
`preset: <name> <version> (<source>)` first, then
`modified: [<layer>] <path>` and `missing: [<layer>] <path>` lines.

**Exit codes:** `0` clean; `1` drift, or no `.rad/installed.json`; `2` bad
arguments or a malformed manifest.

---

### rad install-preset

```
rad install-preset (--source <dir> | --reapply) [--target <dir>]
```

Installs or updates a preset over an installed core. A preset is `preset.yml`
(`name`, kebab-case; `version`, a string; optional `settings` with
`high_risk_patterns` and/or `hooks_dir`) plus an optional `files/` tree that
mirrors the target. Files may only go under `scripts/hooks/`, `ai/extensions/`,
`.claude/agents/`, or `docs/`.

- **Add-only.** A path another layer owns (such as core) is refused.
- **Same keep-local-edits rules as core.** An edited preset file is kept (new
  version staged), and a deleted one is reported `deleted` and not restored.
- **Settings are seeded only when absent.** With no `settings:` block in
  `.rad/config.yml`, the preset's settings are appended as one (`seeded:`). With
  an existing block the config is untouched: keys it already sets are reported
  `kept:`, missing ones `unseeded:` for the operator to add by hand.
- The preset's name, version, and absolute source path are recorded in the
  manifest. Only one preset per project: a different name is refused.
- `--reapply` installs from the recorded source, picking up changes there. With
  no preset recorded it prints `nothing to do` and exits 0. A recorded source
  that is missing or not a directory exits 2, naming the path and the fix.

Every refusal happens before anything is written.

**Exit codes:** `0` all written and seeded; `1` a file was kept or deleted, or a
setting was unseeded; `2` nothing written: bad arguments, an invalid preset,
core not installed, a malformed manifest, a missing or invalid
`.rad/config.yml`, a path another layer owns, a different preset already
installed, or (`--reapply`) a missing recorded source.

---

## Smoke testing rad deliver

### Step 1 — verify tests pass (no API call)

```bash
node --test harness/test/deliver.test.js
```

Three cases: dispatch smoke, ANTHROPIC_API_KEY guard, gate refusal. All run
without hitting the API.

### Step 2 — verify SDK shape (no API call)

```bash
node -e "import('@anthropic-ai/claude-agent-sdk').then(m => console.log('query:', typeof m.query))"
# → query: function
```

### Step 3 — verify CLI help

```bash
node harness/cli.js --help
node harness/cli.js deliver --help
```

Both should exit 0 and include `deliver` in the output.

### Step 4 — live API run

Create and approve a minimal one-task plan, then run:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node harness/cli.js deliver <feature>
```

Watch for:
- Wave announcement line (`━━━ Wave 1 ...`)
- Streamed agent output
- `WAVE_RESULT` block in the output
- Exit 0 and structured summary line

---

## SDK interface notes

`runwave.js` uses `query` from `@anthropic-ai/claude-agent-sdk`. The confirmed
options shape as of SDK install (2026-06-05):

| Option | Value used | Notes |
|--------|-----------|-------|
| `prompt` | wave prompt string | top-level param, not in options |
| `options.cwd` | `repoRoot` | sets working directory for the sub-agent |
| `options.env` | `{ ...process.env, ANTHROPIC_API_KEY }` | **replaces** subprocess env; spread process.env explicitly |
| `options.model` | `claude-opus-4-8` (default) | passed if provided |
| `options.tools` | `{ type: 'preset', preset: 'claude_code' }` | enables full Claude Code tool set |
| `options.allowedTools` | `['Read','Write','Edit','Bash','Glob','Grep']` | auto-allowed without permission prompts |
| `options.permissionMode` | `'acceptEdits'` | suppresses interactive permission prompts |
| `options.persistSession` | `false` | each wave is a fresh session |

The `env` field is the correct way to pass `ANTHROPIC_API_KEY` to the sub-agent
subprocess — not a top-level `apiKey` parameter (the SDK has no such parameter).

---

## CI checks

The CI layer is **scripts-first and runner-neutral**: every check is a
standalone script under `scripts/`, callable locally with the exact command
lines below. GitHub Actions is the default thin wrapper —
`.github/workflows/ci.yml` contains zero check logic, only checkout + invoke —
and any other CI platform wraps the same scripts the same way.

**Adopter prerequisite — branch protection.** The authenticity check verifies
*who authored* the approval commit; it cannot stop a rewritten branch from
presenting a forged history. Protect `rad/*` branches on your host (no
force-push, required reviews) — that protection is the substrate beneath the
authenticity check, not something these scripts replace.

### check-approval-integrity.sh

```
scripts/check-approval-integrity.sh <work-branch> [base-branch]
```

Deliver-PR integrity check over a feature's approval authority. Verifies, at
the PR head, that the recorded approval is REAL, CURRENT, and AUTHENTIC:

- **Ancestry** — the commit that introduced the gating (latest) `approved`
  event in `.agents/state/<feature>/events.jsonl` must be an ancestor of HEAD.
- **Fingerprint + gate** — the approved event's `data.fingerprint` must equal
  the current `rad plan-fingerprint` of the plan doc, then the events JSONL
  must satisfy the pure gate fold (`rad gate <feature> approved --stdin`).
  Legacy events with **no stored fingerprint warn but PASS** — a deliberate
  narrow fail-open mirroring `check-plan-approved.sh`.
- **Authenticity** — the introducing commit's git author email must match the
  architect identity in `.rad/config.yml` (`rad config get roles.architect`).
  `RAD_ARCHITECT_OVERRIDE` wins when set (see `.env.example`).
- **Ownership** — advisory ONLY: a stale `owner-claimed` with no later
  `owner-released` prints an `advisory:` line. **Never affects the exit code**
  — CI surfaces these lines as warning annotations, nothing more.

`base-branch` defaults to the detected default branch (fallback `main`). All
ambiguity (missing plan, missing log, unparseable event, undeterminable
ancestry) **fails closed**.

```bash
scripts/check-approval-integrity.sh rad/email-confirmation main
```

**Exit codes:** `0` = approval integrity verified, `1` = check failed (or any
ambiguity — fail closed), `2` = usage error.

### check-events-append-only.sh

```
scripts/check-events-append-only.sh <base-ref> [head-ref]
```

All-PR check: the RAD event logs (`.agents/state/*/events.jsonl`, including
the reserved `.agents/state/_architecture/events.jsonl`) are append-only audit
trails. For every event log touched in `git diff <base>...<head>`:

- FAIL if the diff removes or modifies any existing line;
- every ADDED line must parse as JSON and carry non-empty string fields
  `feature`, `type`, `actor`, `ts`.

Files outside `.agents/state/**/events.jsonl` are ignored; no relevant changes
→ exit 0 with a "no event-log changes" notice. Unresolvable refs **fail
closed**. `head-ref` defaults to `HEAD`.

```bash
scripts/check-events-append-only.sh origin/main
```

**Exit codes:** `0` = pass (append-only, all added events well-formed — or
nothing to check), `1` = fail (rewrite/deletion detected, malformed event, or
error — fail closed), `2` = usage error.

### lint-agent-files.sh

```
scripts/lint-agent-files.sh [claude-md] [agents-dir]
```

All-PR repo-convention lint over the agent definitions. **Read-only** — it
reports drift, never rewrites anything (reconciling scope-map drift is the
architect's call). Two parts:

- **Frontmatter lint** — every `<agents-dir>/*.md` must open with YAML
  frontmatter carrying non-empty `name`, `description`, `model`, `tools`;
  `name` must equal the filename minus `.md`; context tools (tools drawn from
  {Read, Grep, Glob}) must use a `claude-haiku` model, must not list Task, and
  their description must start with "MUST BE USED" or "Use PROACTIVELY".
  Files without a `roles:` field are RAD-external utility agents — basic
  frontmatter is linted, but they are exempt from the context-tool rules and
  the scope-map bijection.
- **Scope-map sync** — every `agent_scope_map` row in `.rad/config.yml` (read
  via `rad config get agent_scope_map`) must have a matching agent file, and
  every agent file with `roles:` must have a row.

Usage: `scripts/lint-agent-files.sh [repo-root] [agents-dir]`. Defaults: this
script's checkout and `.claude/agents`.

```bash
scripts/lint-agent-files.sh
```

**Exit codes:** `0` = clean, `1` = one or more violations (each reported with
file + reason), `2` = usage error (RAD harness or agents dir not found). A missing or invalid
`.rad/config.yml` fails closed with `1`.

---

## Known follow-ups

- **Decision 2** (DONE): `events.jsonl` is now the sole approval authority. The
  read-only `rad gate <feature> approved` verb folds the event log,
  `check-plan-approved.sh` gates on that event, and the plan doc's `Status:`
  header is a display-only mirror. `rad approve` still writes the header for human
  display, but nothing gates on it.
- **CLI cutovers**: `rad status`, `rad plan`, `rad design` as follow-up increments.
- **Redundant role check**: `approveCommand` calls `check-role.sh` upfront for UX
  and `recordApproval` calls it again internally. Harmless; clean up post-Decision 2.
