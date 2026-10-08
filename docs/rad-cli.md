# rad CLI

The `rad` CLI is a thin, deterministic composition layer over the harness ports.
It owns the pure mechanics that the `/rad-*` prose commands used to inline; the
prose commands retain the human-in-the-loop steps and shell out here for recording
and execution.

The CLI never calls a model on its own and never opens a PR — `rad approve` is
pure git/state work; `rad deliver` delegates model calls to a selectable agent
adapter (a spawned CLI agent or the Claude Agent SDK) but does not call any API
itself. It pushes a branch only in `approve`, `plan-open` and `plan-status`.
`checkout` switches the checked-out branch but never pushes.

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
rad approve <feature> [--on-behalf-of <name>] [--evidence <text>] [--no-commit] [--trailer "Key: Value"]...
```

Records an architect approval and, by default, publishes it on the work branch:
1. checks authority, then the approval blockers (`scripts/check-approval-blockers.sh`);
2. refuses unless HEAD is the plan's work branch with nothing staged;
3. appends an `approved` event to `.agents/state/<feature>/events.jsonl` — this
   event is the **sole approval authority**; the gate reads it, not the doc — and
   writes `Status: approved`, `Approved-By`, `Approved-At` headers to the plan doc
   (`Recorded-By` and `Approval-Evidence` in proxy mode). These headers are a
   **display-only mirror** of the event; nothing gates on them;
4. commits **only** the plan doc and the event log;
5. pushes the work branch;
6. labels the issue `approved`.

No PR is opened and nothing is committed to the default branch. The
`/rad-approve` prose command calls this after the architect confirms.

**Authority:**
- Direct: the running `git user.email` must be a configured architect in `.rad/config.yml` (`roles.architect`)
- Proxy: `--on-behalf-of <name>` records an out-of-band approval; `--evidence` is
  required and captured in the event log. `<name>` must be a configured architect.

**Derived commit message:** subject `approve: <feature>`, or
`approve: <feature> (re-approval)` when the event log already holds an approval.
The body carries `Plan`, `Issue` (when the plan has one) and `Approved-By`, plus
`Recorded-By` and `Approval-Evidence` in proxy mode, followed by any `--trailer`
lines.

**`--trailer`:** repeatable; each value must be a single-line `Key: Value`. Pass
one per attribution line your tool requires. An invalid trailer, or `--trailer`
with `--no-commit`, is a refusal (exit 2).

**Resume:** when the latest `approved` event's fingerprint matches the current
plan body, a rerun records nothing new and resumes the publish — it commits if
the files still have changes, pushes if origin lags, then labels. The success
line then carries `resumed=true`. There is no rollback.

**`--no-commit`:** the previous behavior — record the event and the header only,
with no branch check, commit or label. The push is best-effort and happens only
under `RAD_SYNC`; its failure never fails the command.

**Labelling:** runs only after a successful push. The issue comes from the plan's
`Issue:` header; without one the command prints `label skipped: no issue`.

**Success line:**
`rad approve: ok feature=<f> status=approved approved-by=<who> [recorded-by=<who>] approved-at=<ts> proxy=<bool> committed=<bool> pushed=<bool> [resumed=true]`.
`committed`, `pushed` and `resumed` are absent under `--no-commit`.

**Exit codes:**
- **0** — recorded (or resumed), committed if needed, pushed and labelled.
- **1** — refused for authority or blockers (nothing written), a bad argument
  or a missing plan doc, or the commit, push or label failed after recording. A
  publish failure is safe to rerun; the rerun resumes.
- **2** — refused before writing, nothing changed: HEAD is not the work branch,
  staged changes are present, an invalid `--trailer`, or `--trailer` with
  `--no-commit`.

---

### rad plan-open

```
rad plan-open <plan-file> [--trailer "Key: Value"]...
```

Opens a plan's work branch: the one deterministic step behind `/rad-plan` Step 5
and `/rad-adopt` Step 7, callable from any coding tool. On a fresh run it:
1. fetches the default branch and runs `git checkout -b <branch> origin/<default>`;
2. stages **only** the plan file and commits it with a message derived from the plan;
3. pushes with `push -u origin <branch>`;
4. labels the issue `pending-review`.

No PR is opened and nothing is committed to the default branch.

**Derived commit message:** subject `plan: <title>`, or `adopt: <title>` when the
plan has an `Adopted-From:` header. The body carries `Adopted-From`, `Issue`,
`Author`, `Waves`, `Tasks` and `Out-of-scope deps`, followed by any `--trailer`
lines.

**`--trailer`:** repeatable; each value must be a single-line `Key: Value`. Pass
one per attribution line your tool requires. An invalid trailer is a refusal.

**Refusals (exit 2, nothing changed):**
- bad argv or an invalid `--trailer`
- the path is not `.agents/plans/<slug>.md`, or the slug is invalid
- the `Branch:` header is missing or is not `rad/<slug>` (the prefix honors
  `RAD_BRANCH_PREFIX`)
- `scripts/lint-plan.sh` fails (its output is passed through)
- uncommitted changes to tracked files
- the branch exists only on origin
- a local branch with commits unrelated to this plan
- the default-branch lookup or the fetch fails

**Resume:** a rerun picks up where a previous run stopped — at the commit step or
the push step. Any failure after the branch exists exits 1 with a message that a
rerun is safe; there is no rollback.

**Labelling:** runs only after a successful push. The issue comes from the
`Issue:` header, or is parsed from an `Adopted-From:` issue URL. Without either
the command prints `label skipped: no issue`. A labelling failure exits 1 (the
branch is already pushed; a rerun is safe).

**Sync:** it always pushes and ignores `RAD_SYNC`.

**Success line:**
`rad plan-open: ok feature=<slug> branch=<branch> commit=<sha> issue=<N|none>`

**Exit codes:** 0 on success; 1 when a step failed after the branch exists
(rerun is safe); 2 on a refusal (nothing changed).

---

### rad plan-status

```
rad plan-status <feature> <rejected|needs-revision> [--trailer "Key: Value"]...
```

Records an architect's non-approval review of a plan: the one deterministic step
behind the **no** and **feedback** answers in `/rad-approve`, callable from any
coding tool. It:
1. sets the plan doc's `Status:` header to the given status;
2. commits **only** the plan file on its work branch with a message derived from
   the plan;
3. pushes the work branch;
4. labels the issue with the status.

No PR is opened and nothing is committed to the default branch. For **feedback**,
append the `## Architect Feedback` section to the plan file first; the command
commits it along with the header.

**Derived commit message:** subject `review: <feature> <status>`. The body
carries `Plan`, `Issue` (when the plan has one) and `Reviewed-By` (the running
`git user.email`), followed by any `--trailer` lines.

**`--trailer`:** repeatable; each value must be a single-line `Key: Value`. Pass
one per attribution line your tool requires. An invalid trailer is a refusal.

**Refusals (exit 2, nothing changed):**
- bad argv, an invalid `--trailer`, an invalid feature name, or a status other
  than `rejected` or `needs-revision`
- no plan file at `.agents/plans/<feature>.md`
- the running user is not a configured architect
- the plan's `Status:` is `approved`, `in-progress` or `complete`
- the `approved` gate passes (the event log records an approval)
- HEAD is not the plan's work branch, or staged changes are present
- no `git user.email` is set

**Rerun:** if the plan already has the requested status, the run is a rerun: it
commits only if the plan file has changes (for example, newly written feedback),
then pushes if origin lags and labels. A push or label failure exits 1 with a
message that a rerun is safe; the rerun resumes. There is no rollback.

**Labelling:** runs only after a successful push. The issue comes from the plan's
`Issue:` header; without one the command prints `label skipped: no issue`.

**Success line:**
`rad plan-status: ok feature=<f> status=<status> committed=<bool> pushed=<bool> issue=<n|none>`.

**Exit codes:** 0 committed (if needed) and pushed; 1 a publish step failed
(rerun resumes); 2 refused, nothing changed.

---

### rad checkout

```
rad checkout <feature | .agents/plans/<feature>.md>
```

Checks out a plan's work branch at its remote tip. This is how `/rad-approve`
gets onto the work branch before it reviews the plan, and any coding tool can
call it. It wraps `scripts/checkout-plan.sh` and adds no git logic of its own.
It:
1. resolves the branch from the feature name by convention (`rad/<feature>`,
   honoring `RAD_BRANCH_PREFIX`). It never reads a local plan header, because
   the plan is not on the default branch before checkout;
2. runs `scripts/checkout-plan.sh <branch>`, which fetches the branch from
   origin, checks it out and fast-forwards it to the remote tip;
3. confirms that `.agents/plans/<feature>.md` exists at the branch tip.

It changes the checked-out branch but commits nothing and never pushes.

**Argument:** `<feature>`, `<feature>.md` or `.agents/plans/<feature>.md`.
`--help` / `-h` prints the usage line and exits 0.

**Refusals (exit 2, before any git call):**
- an unknown option, or not exactly one argument
- an argument in none of the accepted shapes
- an invalid feature name (expected `/^[a-z0-9][a-z0-9-]*$/`; the reserved
  `_architecture` slug is refused)

**Failures (exit 1):**
- `scripts/checkout-plan.sh` failed (an invalid branch name, a branch missing on
  origin, or a local branch that has diverged); its output is passed through
- the branch checked out, but the plan file is missing at its tip
- `git rev-parse HEAD` failed

**Success line:**
`rad checkout: ok feature=<f> branch=<branch> head=<sha> plan=.agents/plans/<f>.md`

**Exit codes:** 0 on the branch at its remote tip with the plan present; 1 the
checkout script failed or the plan is missing; 2 refused before any git call.

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

### rad pr-body

```
rad pr-body <feature> [--branch <ref>] [--base <ref>]
```

A read-only preview of the **deliver PR title and body** exactly as `rad
deliver` builds them at open-pr time (`harness/pr-body.js`). It records
nothing, opens no PR, and fetches nothing. `--branch` defaults to `rad/<feature>`;
`--base` defaults to `scripts/get-default-branch.sh`, else `main`.

**Inputs**, all read from the branch, never the working tree:

- **plan** — `.agents/plans/<feature>.md` at the branch tip; its `# Plan:`
  heading becomes the title (`Deliver: <heading>`, falling back to the feature
  slug) and its `Issue:` (or `Adopted-From:`) header the issue line
- **event log** — `.agents/state/<feature>/events.jsonl` at the branch tip; per
  wave, the tasks from the last passing wave attempt. A missing log is noted on
  stderr and renders the waves as empty
- **commits** — `origin/<base>..<branch>`, oldest first, capped at 100
- **tests** — each `## Tests to Write` path, checked for presence in the branch
  commit (`git cat-file -e`)
- **scope** — `scripts/check-scope.sh`, run for real against a temp copy of the
  tip plan (always removed). In `rad deliver` this line is always `passed`,
  since the spine only reaches open-pr after check-scope passes

An input that can't be read renders as an **unavailable** line with the reason
and never blocks the output. Closing keywords in agent-written text are
neutralized (`fixes #12` → `fixes issue 12`) and the issue line is `Issue: #N`,
never `Closes #N` — closing the issue is the architect's call at merge.

**Output** is the title, a blank line, then the body:

```
Deliver: Deterministic Deliver PR Body

Plan: `.agents/plans/deliver-pr-body.md`

Issue: #186

## Waves

### Wave 1
- ✓ The pure PR body builder — 27c1217

### Wave 2
- ⚠ Deliver wiring — 60871ae — concern: <concern text>

### Wave 3 (test wave)
- ✓ Write harness/test/pr-body.test.js — 9a1c3e2

## Commits
- d5b51fd deliver(deliver-pr-body): begin execution
- 27c1217 deliver(deliver-pr-body): the pure PR body builder

## Tests to Write
- ✓ harness/test/pr-body.test.js
- ✗ scripts/test-example.sh (missing)
- ? <item> (unresolvable)

## Checks
- check-scope: passed

Generated by rad deliver from the plan and the event log.
```

Task icons: `✓` complete, `⚠` done_with_concerns. Test icons: `✓` present,
`✗` missing, `?` unresolvable path.
The end-of-run test wave (see [Per-wave test gate](#per-wave-test-gate)) is
marked `(test wave)` in its heading.

**Stale base:** the commit range uses your local `origin/<base>` and `rad
pr-body` does not fetch — run `git fetch` first if it may be behind.

**Exit codes:** `0` on any output (including unavailable inputs), `1` on a
malformed event log or a base-resolution failure, `2` on bad arguments, an
unsafe feature name, or no plan at the branch tip.

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
`RAD_REVIEW_AGENT_CMD`, then `RAD_AGENT_CMD`, then `agent.command` from
`.rad/config.yml` — used only when `agent.adapter` is `command` (an `sdk` or
`acp` agent has no command the review lane can spawn). None of them → exit 2
with `no review agent configured — set RAD_REVIEW_AGENT_CMD, RAD_AGENT_CMD, or
agent: in .rad/config.yml`. An invalid config is consulted as absent, so an
environment command still works; with no environment command it is reported as
the reason. The agent
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
stderr, naming the winning source and only the executable's basename — never
the full command string:

```
rad review: reviewer=<reviewer> agent=<RAD_REVIEW_AGENT_CMD|RAD_AGENT_CMD|agent.command> executable=<basename> findings=<n|none>
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

**Verified for `rad deliver`.** "Verified" here means `RAD_EVAL_LIVE_CMD="<cmd>"
node --test harness/evals/*.eval.js` exited **0** with both live delivery cases
(`prompt-injection-in-intake`, `read-only-question`) passing; the scripted-only
cases report as skipped in that lane.

| Agent preset | `RAD_EVAL_LIVE_CMD` | Verified |
|--------------|---------------------|----------|
| `claude` | `claude -p` | 2026-10-08 — exit 0, 2 live cases passed (59 skipped) |
| `codex` | `codex exec` | 2026-10-08 — exit 0, 2 live cases passed (59 skipped) |

---

### rad deliver

```
rad deliver <feature> [--model <model-id>] [--resume --context <text>]
```

Drives wave execution for an approved plan. Reads the plan file, constructs
per-wave prompts, selects an **agent adapter** (see below), calls `deliverSpine`
with the adapter's `runWave`, and streams wave output to stdout. The plan must be
in `Status: approved` on its `rad/<feature>` branch tip.

#### Prepare phase

Before orphan handling and the first wave, `rad deliver` prepares the work
branch in the run root (the worktree, or the repo root with `RAD_WORKTREE=0`):
it fetches origin, fast-forwards to `origin/<branch>` if that is ahead, merges
`origin/<default>` (`--no-edit`; never rebase or force-push), sets the plan to
`Status: in-progress`, commits only the plan (`deliver(<f>): begin
execution`), pushes, and labels the issue `in-progress`. Re-running is safe.
Success records the audit-only `run-prepared` event.

- **A reachable `origin` is required** — an unreachable remote stops the run
  with `prepare-failed` (exit `1`).
- **Main mode (`RAD_WORKTREE=0`)** must be on the work branch with nothing
  staged, or the run stops with `prepare-failed`.
- A merge conflict aborts the merge, leaves the tree unchanged, and stops with
  `merge-conflict` (exit `3`) — see [Resuming a stopped run](#resuming-a-stopped-run).
- Failing to resolve the default branch exits `1` before the spine starts.

Full contract: [Prepare phase](./rad-wave-contract.md#prepare-phase).

#### Per-wave test gate

After each wave, `rad deliver` checks that the `## Tests to Write` files
**promised** by the waves completed so far exist. A wave promises a test file
when one of its tasks lists that exact path on its `File:` line. After wave k the
gate checks the union promised by waves 1..k and is skipped when that union is
empty; a missing promised file demotes the wave to `fail-tests` at that wave. On
`--resume`, the resume verify checks only the files promised by the completed
waves. Files no wave promises are not checked during the waves.

**Test wave.** After the last plan wave, if any `## Tests to Write` file that no
wave promises is missing, `rad deliver` runs one extra wave N+1 (N = the highest
plan wave), one task per missing file, through the normal wave machinery
(approval re-check, budget, hooks, retries, doom loop, per-wave gate,
`--resume`). It uses the default model, inherits the plan-level `Capabilities:`
line, and runs at most once — a completed test wave is not re-run on resume. A
final guard then re-checks the unpromised files (also on resume); anything still
missing stops with `tests-missing` (exit `1`). Write the files on the branch and
re-run `rad deliver` — no `--resume` needed. The `waves=` count stays the plan's
wave count, and the PR body labels the wave `### Wave N (test wave)`. Plans whose
test files are all promised are unaffected.

The gate calls `scripts/check-tests-present.sh` with `--only`:

```
scripts/check-tests-present.sh <plan-file> [--only <path>...]
```

- Without `--only` — unchanged: every `## Tests to Write` entry is checked.
- With `--only` — only the listed `## Tests to Write` paths are checked; every
  other line, including unresolvable ones, is ignored. When none of the listed
  paths is in the section it prints `(no promised tests yet)` and exits `0`.
- `--only` with no paths, or an unknown flag, exits `2`.

Full contract: [Between-wave checks](./rad-wave-contract.md#between-wave-checks).

#### Finish phase

After the last wave, `rad deliver` runs the approval-during-run guard and
`check-scope.sh`, then finishes in the run root:

1. **beforePr** — sets the plan to `Status: complete` with `Completed-At:` (kept
   on a rerun), commits the plan and the event log (`deliver(<f>): mark plan
   complete`), pushes (required in both modes; no `RAD_SYNC` gate), and labels
   the issue `review`. A failure stops with `finish-failed` (exit `1`) and the
   PR is not opened.
2. **open-pr.sh** — opens the PR with a generated title (`Deliver: <plan
   heading>`) and a deterministic body built from the plan, the event log, the
   branch commits, `## Tests to Write` presence and the scope check; issue
   references never use a closing keyword. Preview it any time with
   [`rad pr-body`](#rad-pr-body). An existing **open** PR/MR for the head branch
   counts as success: it prints `PR already open: <url>`, exits `0`, and creates
   nothing. A failing lookup exits non-zero and never falls through to create.
3. **`pr-opened`** is appended — the feature is now `delivered`.
4. **afterPr** — commits the event log (`deliver(<f>): record pr-opened`),
   pushes, and labels `review`. Nothing is recorded after `pr-opened`, so a
   failure here appends no event; the run exits `1` with the `finish-failed`
   decision line.

Full contract: [Finish phase](./rad-wave-contract.md#finish-phase).

#### Adapter selection

The agent comes from one of two sources, never mixed (full reference:
[Agent Adapter](configuration.md#agent-adapter)):

1. **Environment** — if `RAD_AGENT` or `RAD_AGENT_CMD` is set (non-blank), the
   variables below decide everything, exactly as before, and `agent:` is
   ignored.
2. **`agent:` in `.rad/config.yml`** — otherwise, `agent.adapter` and
   `agent.command` play the roles of `RAD_AGENT` and `RAD_AGENT_CMD`. Write it
   with `rad config init --agent claude|codex` (presets `claude -p` /
   `codex exec`) or `--agent-cmd "<cmd>"` / `--agent-adapter sdk`.

Neither → `rad deliver` exits **2** with `no agent configured — set agent: in
.rad/config.yml (rad config init --agent claude|codex) or
RAD_AGENT/RAD_AGENT_CMD`, before any worktree or event. (A config `agent:` with
`adapter: command|acp` but no command is already rejected by config
validation.)

| Env var | Values | Default | Meaning |
|---------|--------|---------|---------|
| `RAD_AGENT` | `command` \| `sdk` \| `acp` | `command` | which adapter drives the wave |
| `RAD_AGENT_CMD` | any command string | — | the CLI to spawn (command and acp paths) |
| `RAD_AGENT_PREFLIGHT` | `off` | — (probe runs) | exactly `off` skips the command- and acp-path startup preflight |
| `RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS` | positive integer | `60` | preflight probe deadline; malformed exits 2 |
| `RAD_TOKEN_BUDGET` | positive integer | — | per-deliver cumulative token ceiling (cost breaker) |
| `RAD_REVIEW_AGENT_CMD` | any command string | — (falls back to `RAD_AGENT_CMD`, then `agent.command`) | review-lane CLI for [`rad review`](#rad-review) and `/rad-review`; not used by `rad deliver` |

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
| `3` | needs a human decision — a `needs-decision` stop, e.g. `merge-conflict` (see [Resuming a stopped run](#resuming-a-stopped-run)) |

See the Stop contract in [`rad-wave-contract.md`](./rad-wave-contract.md#stop-contract)
for the stop classes behind `1` and `3`.

A `finish-failed` stop exits `1` and is not resumable; a plain rerun recovers it.
Re-running a feature that is already `delivered` (plain or `--resume`) skips the
gate, prepare and waves: in main mode it re-runs afterPr (commit and push the
event log, label `review`); in worktree mode it pushes the work branch (never
forced) and labels `review`. It prints `rad deliver: already delivered
feature=<f>` and exits `0`; any failure prints the reason and exits `1`. The
log is read from the branch tip in worktree mode, the repo root in main mode.

#### Resuming a stopped run

A run that stopped with class `needs-decision` (exit `3` — `token-budget`,
`failed-attempt-cap`, `approval-changed`, `merge-conflict`, or a matrix/hook-veto
`surface`) can be
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

For a `merge-conflict` stop, resolve the conflict on the work branch — in the
preserved worktree in worktree mode, since a stop keeps it — commit, then resume:

```bash
node harness/cli.js deliver my-feature --resume --context "<what you did>"
```

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

   **Exception:** an afterPr failure in the [finish phase](#finish-phase) comes
   after `pr-opened`, so the run is delivered and the worktree is torn down as
   if completed (the teardown safety-net commit puts `pr-opened` on the local
   branch); the run still exits `1`. If that commit fails, the worktree is
   preserved as usual.

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
`install-core`, `install-status` and `install-preset` work on
`.rad/installed.json`, where each tracked file carries its
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

### rad install-hooks

```
rad install-hooks [--target <dir>]
```

Registers the deliver-gate PreToolUse hook (`scripts/deliver-gate-hook.mjs`)
in the target's `.claude/settings.json`. An absent file is created; a file that
already registers the hook (any PreToolUse hook command containing
`deliver-gate-hook.mjs`) is left untouched; otherwise a `Skill`-matcher entry is
appended, keeping every other key and its order. It prints
`rad install-hooks: <created|added|present> .claude/settings.json`.

- **Fail-closed.** Nothing is written when `.claude/settings.json` is empty,
  malformed or the wrong shape, is a symlink or not a regular file, or when
  `<target>/scripts/deliver-gate-hook.mjs` is missing.
- **Atomic.** The merged file is written in one rename, and never when the
  status is `present`.
- `install.sh` runs it after the core install, on a fresh install and on
  `--upgrade`. `.claude/settings.local.json` is never touched.

**Exit codes:** `0` `created`, `added` or `present`; `2` nothing written: bad
arguments, a settings file that cannot be merged, a symlinked or non-regular
settings file, or a missing hook script.

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
scripts/lint-agent-files.sh [repo-root] [agents-dir]
```

All-PR repo-convention lint over the agent definitions. **Read-only** — it
reports drift, never rewrites anything (reconciling scope-map drift is the
architect's call). Three parts:

- **Frontmatter lint** — every `<agents-dir>/*.md` must open with YAML
  frontmatter carrying non-empty `name`, `description`, `model`, `tools`;
  `name` must equal the filename minus `.md`; context tools (tools drawn from
  {Read, Grep, Glob}) must use a `claude-haiku` model, must not list Task, and
  their description must start with "MUST BE USED" or "Use PROACTIVELY".
  Files without a `roles:` field are RAD-external utility agents — basic
  frontmatter is linted, but they are exempt from the context-tool rules and
  the scope-map bijection.
- **Purpose** — every agent file with `roles:` must declare a non-empty
  `purpose:` that is one of `authority`, `context-discipline` or `capacity`
  (see [UPGRADE.md](../UPGRADE.md#agent-purpose-tags-46)). A `capacity` agent
  passes but prints a non-blocking `advisory:` line, because capacity is
  provisional; advisories never change the exit code.
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
