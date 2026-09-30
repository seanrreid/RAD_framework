# Plan: Cross-Vendor Review Lane (`rad review`)
Created: 2026-09-30
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-30T18:49:50.139Z
Recorded-By: sean@torchcodelab.com
Branch: rad/cross-vendor-review-lane
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/110
Issue-Title: Cross-vendor review lane: let the review agent resolve to a different provider than the delivery agent

## Context

The review lane (`/rad-review`'s `quality-reviewer` and `accessibility-reviewer`) runs on the same agent as delivery, so the reviewer inherits the implementer's blind spots. #110 asks for the review lane to resolve to a **different** configured provider, record which one it used, and ship a provider cookbook with verified rows. This plan runs in parallel with #87 (the config split), as agreed for the strategic arc.

**What research found:**
- **No CLI review verb exists yet.** Review runs only as `/rad-review` skill sub-agents (Step 4 at `rad-review.md:124-133`, Step 4b at `:135-144`). Their `rad-findings` blocks are pulled out in Step 7 (`:263-298`); the cycle record is at `:295`.
- **The command adapter has the right primitive, but it's private.** `harness/adapters/agent/command.js` `spawnOnce` (`:196`) runs a command with a prompt under the `ENV_ALLOW_LIST` (`:44`), with the output cap and sanitized errors. `probeCommand` (`:262-284`) is the pattern for a generic runner. WAVE_RESULT parsing happens only inside `createCommandAdapter`.
- **The helpers live in the eval harness.** The reviewer prompt/parse helpers from #160 are in `harness/evals/reviewers/lib.js` (`stripFrontmatter` `:39`, `buildReviewPrompt` `:44`, `parseFindings` `:49`, `REVIEW_INSTRUCTION` `:22`, which hardcodes `main...HEAD`). Importing them into the product CLI would invert the layering.
- **CLI patterns to copy:** `digestCommand` (`cli.js:2311`, argument parsing `:2256-2261`, default base via `readDefaultBranch`) and `resolveAgent` (`:623`; it reads `RAD_AGENT_CMD` with a hardcoded "rad deliver:" error).
- **Docs:** `.env.example` documents `RAD_AGENT_CMD` (`:17-22`). `docs/rad-cli.md` has an adapter selection table (`:224-233`) and examples (`:276-282`). `docs/invariants.yaml` `adapter-env-allow-listed` (`:169-179`) names only `RAD_AGENT_CMD`.
- **Agent CLIs installed here:** `claude`, `codex` and `opencode` are available, so the cookbook can carry verified rows, including a non-Anthropic one.

**Architect decision (2026-09-30):** a `rad review <reviewer> [--base <ref>]` verb runs one reviewer agent file through the command adapter, using `RAD_REVIEW_AGENT_CMD` or else `RAD_AGENT_CMD`, under the same env allow-list. `/rad-review` calls it when `RAD_REVIEW_AGENT_CMD` is set, and uses today's sub-agents otherwise. The provider used goes into the findings cycle record.

## Scope

| In scope | Out of scope |
|---|---|
| `harness/review.js` (shared prompt/parse), with evals re-exporting it | Changing the reviewer agent prompts |
| Exported allow-listed `runCommandPrompt` in `command.js` | Any change to the deliver/wave path |
| `rad review <reviewer> [--base <ref>]` + `RAD_REVIEW_AGENT_CMD` | Routing intelligence or per-wave model tiers (#65) |
| `/rad-review` uses `rad review` when `RAD_REVIEW_AGENT_CMD` is set; the cycle record gains `review_agent` | The ACP protocol (#86) |
| Provider cookbook in `docs/rad-cli.md` with verified rows; `.env.example` | A CI job running live reviews (the #160 lane already exists) |

## Acceptance Criteria

1. `harness/review.js` exports `stripFrontmatter`, `reviewInstruction(base)`, `buildReviewPrompt(agentMd, { base = 'main' })` and `parseFindings(stdout)`, with #160's semantics. `harness/evals/reviewers/lib.js` re-exports them (and keeps `REVIEW_INSTRUCTION` = `reviewInstruction('main')`), so every existing reviewer test and eval passes unchanged.
2. `command.js` exports `runCommandPrompt({ cmd, prompt, repoRoot, timeoutMs, label })` → `{ ok, stdout, error }`. It uses the same tokenization, `{prompt}`/stdin rule, `ENV_ALLOW_LIST` child env, output cap, timeout and kill, and sanitized error as the wave path. It never parses WAVE_RESULT and never throws on a child failure.
3. `rad review <reviewer> [--base <ref>]`:
   - **Inputs:**
     - `<reviewer>` must match `^[a-z0-9-]+$` and `.claude/agents/<reviewer>.md` must be readable; otherwise exit 2.
     - The command is `RAD_REVIEW_AGENT_CMD` if non-empty, else `RAD_AGENT_CMD`; with neither set, exit 2 naming both.
     - The base comes from `--base`, else `get-default-branch.sh`, else `main`.
     - The timeout is `RAD_REVIEW_TIMEOUT_SECONDS` (default 600). A malformed value exits 2.
   - **Run:** the prompt is `buildReviewPrompt(agentMd, { base })`, run via `runCommandPrompt` in the repo root.
   - **Output:**
     - **stdout:** the agent's stdout, verbatim.
     - **stderr:** one line, `rad review: reviewer=<r> agent=<RAD_REVIEW_AGENT_CMD|RAD_AGENT_CMD> executable=<basename of the first token> findings=<n|none>`.
   - **Exit codes:** 0 when a `rad-findings` block parsed; 1 when the command failed or no block parsed (the output is still printed); 2 for usage or config errors.
4. With `RAD_REVIEW_AGENT_CMD` unset, nothing about delivery or `/rad-review`'s sub-agent path changes.
5. The review child gets the same env allow-list as the wave child. A test sets a secret env var, runs `rad review` with a fake command that dumps its env, and asserts the secret is absent.
6. `/rad-review` Steps 4 and 4b: when `RAD_REVIEW_AGENT_CMD` is set, run `node harness/cli.js review quality-reviewer --base <base>` (and `accessibility-reviewer`), and include the stdout as that reviewer's output. A non-zero exit is reported and the review continues. Otherwise, use today's sub-agents. The Step 7 cycle record gains `"review_agent": {"source": "subagent" | "RAD_REVIEW_AGENT_CMD", "executable": "<basename or null>"}`. The full command string is never recorded.
7. A test proves the two lanes can resolve to different commands in one process: `RAD_AGENT_CMD` = fake A and `RAD_REVIEW_AGENT_CMD` = fake B, and `rad review` runs B while the deliver adapter resolution still yields A.
8. `docs/rad-cli.md` gains a `### rad review` section and a `RAD_REVIEW_AGENT_CMD` row in the adapter table. It states that cross-vendor review reduces correlated blind spots but is **not** a correctness guarantee, and distinguishes the variable from #160's `RAD_REVIEW_EVAL_CMD`. It also gets a **provider cookbook** table (agent, command, prompt delivery, notes, verified yes/no):
   - At least `claude -p` and `codex exec` are **verified**, each by one recorded smoke run: `rad review quality-reviewer` against a small scratch repo that exits 0 with a parsed `rad-findings` block.
   - opencode is verified if its CLI supports a non-interactive prompt mode; otherwise it's listed unverified with the reason.
   - aider and Flue are listed **unverified** (not installed here).

   `.env.example` documents `RAD_REVIEW_AGENT_CMD` and `RAD_REVIEW_TIMEOUT_SECONDS`.
9. `docs/invariants.yaml` `adapter-env-allow-listed` extends its claim to the review lane and adds an anchor on `runCommandPrompt`. `scripts/lint-invariants.sh` passes.
10. Every suite stays green: the harness tests, the evals (including the reviewer eval suite, which skips without credentials), every shell test under both shells, and `lint-shell-safety`.

## Agent Scope

An `Explore` agent (general, read-only) mapped:
- the command adapter internals
- the CLI subcommand and agent-resolution patterns
- the #160 reviewer library
- the `/rad-review` step layout and cycle record
- the env and docs surfaces, and the registry entry

I checked the installed agent CLIs directly (`claude`, `codex` and `opencode` are present).

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/review.js | 1-80 | New: the shared review prompt/parse helpers |
| harness/evals/reviewers/lib.js | 1-60 | Re-export from `harness/review.js` (the eval-only helpers stay) |
| harness/adapters/agent/command.js | 255-300 | Export `runCommandPrompt` |
| harness/test/agent-adapters.test.js | 1-70 | `runCommandPrompt` tests: ok, failure, timeout, env allow-list |
| harness/cli.js | 45-100 | `REVIEW_USAGE` + `SUBCOMMANDS` entry |
| harness/cli.js | 2340-2420 | New `reviewCommand` (append) |
| harness/test/cli.test.js | 1500-1600 | Tests for AC#3, 5, 7 (append) |
| .claude/commands/team/rad-review.md | 124-144 | Steps 4 and 4b: the `rad review` branch |
| .claude/commands/team/rad-review.md | 290-298 | Cycle record `review_agent` |
| docs/rad-cli.md | 205-290 | `### rad review`, the adapter table row, the provider cookbook |
| .env.example | 12-30 | `RAD_REVIEW_AGENT_CMD`, `RAD_REVIEW_TIMEOUT_SECONDS` |
| docs/invariants.yaml | 165-185 | `adapter-env-allow-listed` covers the review lane |

## Execution Notes

### Do Not Touch
- .claude/agents/quality-reviewer.md, .claude/agents/accessibility-reviewer.md
- The wave path in `command.js` (`createCommandAdapter`) and cli.js `buildRunWave` / `resolveAgent` behavior
- harness/evals/reviewers.eval.js (it must keep passing via the re-exports)

### Key Files
- harness/adapters/agent/command.js — `ENV_ALLOW_LIST` (44), `buildChildEnv` (78), `describeExitFailure` (94), `tokenizeCommand` (166), `spawnOnce` (196), `probeCommand` (262)
- harness/cli.js — `SUBCOMMANDS` (51-95), `resolveAgent` (623), the digest pattern (2256-2340), `readDefaultBranch`
- harness/evals/reviewers/lib.js (1-60); harness/test/agent-adapters.test.js `fakeCmd` (65), `withTempDir` (51)

### Reminders
- **Unset means unchanged.** With `RAD_REVIEW_AGENT_CMD` unset, `/rad-review` and delivery behave exactly as today.
- **Never record the full command string.** Record only the env var that won and the executable's basename.
- **Smoke runs make real model calls** (`claude`, `codex`), so keep them to one small scratch repo per verified row, and record the date and outcome in the cookbook.
- **Long final checks** exceed the 2-minute foreground timeout. Run them with `run_in_background`.

## Wave Plan

### Wave 1 — parallel
Tasks in this wave can run in parallel (disjoint files).

#### Task 1.1: Shared review module
File: harness/review.js:1-80, harness/evals/reviewers/lib.js:1-60
What: Implement AC#1. `reviewInstruction(base)` substitutes the base ref into the instruction.
Validate: AC#1 — `npm test --prefix harness` (including `reviewer-evals.test.js` unchanged); `node --test harness/evals/reviewers.eval.js` (skips without credentials, as before).

#### Task 1.2: Allow-listed command runner
File: harness/adapters/agent/command.js:255-300, harness/test/agent-adapters.test.js:1-70
What: Implement AC#2.
Tests (`fakeCmd`):
- stdout returned on exit 0
- non-zero → `{ ok: false }` with a sanitized error
- a timeout kills the child and reports it
- a secret env var in the parent is absent from the child
- a `{prompt}` token puts the prompt in argv, otherwise it goes on stdin
Validate: AC#2 — `npm test --prefix harness`.

### Wave 2 — sequential
The verb, then the skill and docs.

#### Task 2.1: rad review verb
File: harness/cli.js:45-100, 2340-2420, harness/test/cli.test.js:1500-1600, docs/invariants.yaml:165-185
What: Implement AC#3, 4, 5, 7 and 9.
Tests (fake commands):
- usage errors → 2
- no command configured → 2, naming both variables
- a malformed timeout → 2
- `RAD_REVIEW_AGENT_CMD` wins over `RAD_AGENT_CMD`
- a fallback to `RAD_AGENT_CMD` is reported as such on stderr
- findings parsed → 0; no block → 1 with the stdout still printed
- the prompt received on stdin contains the agent body and the `--base` ref
- env secret absent (AC#5)
- two lanes resolve differently (AC#7)
Validate: AC#3, AC#4, AC#5, AC#7, AC#9 — `npm test --prefix harness`; `scripts/lint-invariants.sh` exits 0.

#### Task 2.2: /rad-review wiring, cookbook and env docs
File: .claude/commands/team/rad-review.md:124-144, 290-298, docs/rad-cli.md:205-290, .env.example:12-30
What: Implement AC#6 and AC#8. For each cookbook row marked verified, run the smoke: a scratch git repo with a small planted defect on a branch, then `RAD_REVIEW_AGENT_CMD="<cmd>" node harness/cli.js review quality-reviewer --base main` run from that repo's root (point the CLI at this checkout). Record exit 0, the finding count and the date in the cookbook.
Validate: AC#6, AC#8, AC#10:
- `grep -n "harness/cli.js review\|review_agent" .claude/commands/team/rad-review.md` is non-empty
- the cookbook has ≥2 verified rows, one non-Anthropic
- the full suite is green

## Tests to Write
- [ ] runCommandPrompt: ok, failure, timeout, allow-list, prompt delivery — harness/test/agent-adapters.test.js
- [ ] rad review verb: args, resolution, exit codes, env allow-list, two lanes — harness/test/cli.test.js

## Non-Goals
- Changing the reviewer prompts, or scoring cross-vendor yield. `/rad-insights` can compare later, now that the `review_agent` field exists.
- Routing, model tiers, or any automatic provider choice.
- ACP / a provider protocol (#86).
- Running live reviews in CI (#160's `evals-live` lane covers regression).

## Out-of-Scope Dependencies
None. All paths are architect-owned, and the author is the architect.

## Risks
- **Smoke runs use real credentials.** `claude` and `codex` run under the operator's own logins (the env allow-list means on-disk or keychain auth only). If a CLI isn't logged in, its row is recorded as unverified with the reason, not faked.
- **Parse fragility across vendors.** Another vendor's model may not emit the four-backtick `rad-findings` block. The verb reports this honestly (exit 1, stdout printed), and `/rad-review` continues.
- **Layering move.** `lib.js` re-exports keep the evals stable; `reviewer-evals.test.js` proves it.
- **Self-protected paths:** `harness/` and `.claude/` trigger advisory lint warnings by design.

## Issue Gaps
- **ASSUMPTION — verb shape.** `rad review` with a `RAD_REVIEW_AGENT_CMD` → `RAD_AGENT_CMD` fallback in the CLI; `/rad-review` uses it only when `RAD_REVIEW_AGENT_CMD` is set. Architect decision, 2026-09-30.
- **ASSUMPTION — "event log" means the findings cycle record.** Review runs are not deliver events. `findings.jsonl` is the review log that `/rad-insights` already reads.
- **ASSUMPTION — recorded identity.** The env var that won plus the executable's basename, never the full command string (it may carry paths or flags).
- **ASSUMPTION — cookbook verification.** It covers the CLIs installed on the architect's machine (`claude`, `codex`, maybe `opencode`). aider and Flue are listed unverified.
