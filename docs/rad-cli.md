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

Records an architect approval. Performs the bootstrap dual-write:
- Appends an `approved` event to `.agents/state/<feature>/events.jsonl`
- Writes `Status: approved`, `Approved-By`, `Approved-At` headers to the plan doc

The `/rad-approve` prose command calls this after the architect confirms.

**Authority:**
- Direct: the running `git user.email` must be a configured architect in `CLAUDE.md`
- Proxy: `--on-behalf-of <name>` records an out-of-band approval; `--evidence` is
  required and captured in the event log

**Exit codes:** 0 on success, 1 on refusal or error.

---

### rad deliver

```
rad deliver <feature> [--model <model-id>]
```

Drives wave execution for an approved plan. Reads the plan file, constructs
per-wave prompts, selects an **agent adapter** (see below), calls `deliverSpine`
with the adapter's `runWave`, and streams wave output to stdout. The plan must be
in `Status: approved` on its `rad/<feature>` branch tip.

#### Adapter selection

The runner is chosen by environment variable — there is no config-file loader.

| Env var | Values | Default | Meaning |
|---------|--------|---------|---------|
| `RAD_AGENT` | `command` \| `sdk` | `command` | which adapter drives the wave |
| `RAD_AGENT_CMD` | any command string | — | the CLI to spawn (command path only) |

**Per-path credential requirements:**

- **`command` (default)** — requires **no** `ANTHROPIC_API_KEY`. Credentials are
  the configured command's concern. `RAD_AGENT_CMD` **is required**; if unset,
  `rad deliver` exits 1 with `RAD_AGENT_CMD is required when RAD_AGENT=command`.
- **`sdk`** — requires `ANTHROPIC_API_KEY`. If unset, `rad deliver` exits 1 with
  `ANTHROPIC_API_KEY is required`.

An unrecognized `RAD_AGENT` value exits 1 with a clear message.

```bash
# Default (command) path — bring your own agent CLI, no API key needed here:
export RAD_AGENT=command            # (or leave unset)
export RAD_AGENT_CMD="claude -p"    # or "codex exec", "aider", a wrapper script
node harness/cli.js deliver my-feature

# SDK path — Anthropic SDK, API key required:
export RAD_AGENT=sdk
export ANTHROPIC_API_KEY=sk-ant-...
node harness/cli.js deliver my-feature
```

See [`rad-wave-contract.md`](./rad-wave-contract.md) for the provider-neutral
wave contract both adapters honor.

**Model:** `--model` defaults to `claude-opus-4-8` and applies to the **`sdk`**
path only (the `command` path's model is the configured command's concern):

```bash
RAD_AGENT=sdk node harness/cli.js deliver my-feature --model claude-sonnet-4-6
```

**Exit codes:** 0 on full completion, 1 on credential/selection failure, gate
failure, or blocked wave.

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

## Known follow-ups

- **Decision 2**: Remove plan-doc `Status:` dual-write from `rad approve`; make
  `events.jsonl` the sole approval authority. `check-plan-approved.sh` currently
  reads the doc; the gate rule needs to change first.
- **CLI cutovers**: `rad status`, `rad plan`, `rad design` as follow-up increments.
- **Redundant role check**: `approveCommand` calls `check-role.sh` upfront for UX
  and `recordApproval` calls it again internally. Harmless; clean up post-Decision 2.
