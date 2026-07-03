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
- Direct: the running `git user.email` must be a configured architect in `CLAUDE.md`
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
| `RAD_TOKEN_BUDGET` | positive integer | — | per-deliver cumulative token ceiling (cost breaker) |

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

#### Worktree isolation (optional)

`RAD_WORKTREE` opts a deliver run into git-worktree isolation. It is **OFF by
default and fully backward-compatible**: unset or empty, `rad deliver` behaves
exactly as before — it runs in the main checkout, constructs no worktree port,
and binds every `check-*.sh` / `open-pr.sh` to the repo root. Any non-empty value
turns it ON.

- **`RAD_WORKTREE`** — any non-empty value enables isolation; unset/empty = OFF.
- **`RAD_WORKTREE_DIR`** — optional base directory for the isolated tree. When
  set, the worktree lands at `$RAD_WORKTREE_DIR/<feature>`; otherwise it defaults
  to `../<repo-basename>-rad-worktrees/<feature>` (a sibling of the main checkout).

| variable | values | default | effect |
| --- | --- | --- | --- |
| `RAD_WORKTREE` | any non-empty value | — (OFF) | isolate the deliver run into a git worktree |
| `RAD_WORKTREE_DIR` | a directory path | sibling `../<repo>-rad-worktrees/<feature>` | base dir for the isolated tree |

**Lifecycle.** When ON, the run moves through a **create → active →
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

**v1 constraint.** The worktree checks out the *same* `rad/<feature>` work branch
this deliver runs on. Git cannot check out a branch that is already checked out in
the main tree, so **the work branch must not be checked out in the main checkout**
when you enable `RAD_WORKTREE`. If it is, `git worktree add` fails and `rad
deliver` exits 1 with a clear `worktree create failed` message rather than
detaching or relocating the branch.

```bash
RAD_WORKTREE=1 node harness/cli.js deliver my-feature
RAD_WORKTREE=1 RAD_WORKTREE_DIR=/tmp/rad-trees node harness/cli.js deliver my-feature
```

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
  architect identity parsed from CLAUDE.md Role Assignments.
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
- **Scope-map sync** — every `### Agent Scope Map` table row in CLAUDE.md must
  have a matching agent file, and every agent file with `roles:` must have a
  table row.

Defaults: `CLAUDE.md` and `.claude/agents`.

```bash
scripts/lint-agent-files.sh
```

**Exit codes:** `0` = clean, `1` = one or more violations (each reported with
file + reason), `2` = usage error (CLAUDE.md or agents dir not found).

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
