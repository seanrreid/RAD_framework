# Plan: The rad exercise Command: Run a Plan's Exercise Block (#52 part 1)
Created: 2026-10-09
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-09T19:10:21.246Z
Recorded-By: sean@torchcodelab.com
Branch: rad/exercise-command
Issue: 52
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/52
Issue-Title: Interactive evaluation step in /rad-review (exercise the artifact)

## Context
`/rad-review` is entirely static: it reads code and diffs but never runs the change. Issue #52 adds an opt-in "exercise the artifact" step. The design questions were settled with the user, and this plan is part 1 of two. It ships the harness side, `rad exercise <feature>`, built like the existing `rad review` lane. Part 2 (a later plan) wires `/rad-review` Step 4c in the hand-written Claude variant and the generated Codex skill, adds the `lint-plan.sh` advisories, the cycle-record field and the plan-format docs.

Settled design, encoded below:
- A first-class command, not a wrapper over `/verify`.
- An optional structured `## Exercise` plan section (`Launch:`, `Drive:`, `Observe (AC#N):`, `Teardown:`).
- Observe-only and fail-open, with opt-in `RAD_EXERCISE_BLOCKING` applied by the review skill, never by the approval gate.
- A throwaway-worktree run with a scrubbed environment, a process-group kill and a timeout.

## Scope
| In scope | Out of scope |
|---|---|
| `harness/exercise.js`: block parser, process-group runner, command | `/rad-review` Step 4c in either variant (part 2) |
| `rad exercise <feature>` and `rad exercise <feature> --check` | `lint-plan.sh` advisories, cycle-record `exercise` field (part 2) |
| `RAD_EXERCISE_TIMEOUT_SECONDS`, `RAD_EXERCISE_BLOCKING` | Plan-format docs and skill/template guidance (part 2) |
| docs/rad-cli.md, the env-allow-list invariant, `.env.example` | Any change to the approval gate, events or `findings.jsonl` |

## Acceptance Criteria
1. **Block parser.** `parseExerciseBlock(planText)` in `harness/exercise.js` reads the `## Exercise` section (ends at the next `## ` heading) and returns `{present, launch, teardown, drive, observes: [{ac, text}], warnings}`. `Launch:` and `Teardown:` are single backticked commands (backticks stripped). `Observe (AC#N): text` records `ac: N`. `present` is true only when at least one Observe line exists, so a block with no Observe lines is treated as absent. It never throws on any input.
2. **Warnings.** The parser reports a warning (never an error) for: an unknown key; an Observe with no `(AC#N)`; an `AC#N` not among the plan's numbered Acceptance Criteria; an empty `Launch:`/`Teardown:`; a block with no Observe lines ("will be skipped"). A plan with no `## Exercise` section has no warnings.
3. **`--check`.** `rad exercise <feature> --check` parses the plan doc, prints one `warning: ...` line per parser warning on stdout, and exits 0. It exits 2 when the plan doc is missing or unreadable. It spawns nothing and creates no worktree (part 2's lint calls it).
4. **Skip.** For a plan whose block is absent (`present` false), `rad exercise <feature>` prints `Exercise: skipped (no recipe)` on stdout, a stderr summary line with `status=skipped`, and exits 0. It spawns no process and creates no worktree.
5. **Isolated run.** For a present block, the command runs in a detached worktree at the branch tip (`rad/<feature>`; a throwaway worktree named `exercise-<feature>` created through `scripts/worktree-lifecycle.sh`, including its `node_modules` link). `Launch:` starts in the worktree as the leader of its own process group, under the same environment allow-list as the `Verify:` gate. The configured agent then runs through `runCommandPrompt` with a prompt carrying `Drive:`, each Observe line with its AC text, and the tail of Launch's output. The prompt tells the agent to end with a `rad-findings` block whose findings use `reviewer: "exercise"` and `category: "behavior"`.
6. **Cleanup in every outcome.** After the agent returns (or fails or times out) the Launch process group gets SIGTERM and then SIGKILL after the grace period, so grandchildren do not survive; `Teardown:` runs under the same scrubbed environment; the worktree is removed. A Teardown failure is logged to stderr with its exit code and never changes the command's exit code.
7. **Output and exit codes.** On success (agent ok, a `rad-findings` block parsed) stdout is the agent's output verbatim, stderr carries `rad exercise: feature=<f> agent=<source> executable=<basename> mode=<observe-only|blocking> findings=<n|none>`, and the exit code is 0. Exit 1 when Launch cannot start or exits non-zero before the agent returns, the agent fails or times out, or there is no parsable findings block: the stderr line then carries a sanitized `error="..."` and prints no findings as if they were clean. Exit 2 for usage errors, no agent configured, an invalid config, or a malformed env value.
8. **Agent.** The agent resolves exactly like the review lane (`RAD_REVIEW_AGENT_CMD`, then `RAD_AGENT_CMD`, then config `agent.command` with the command adapter), injected from `harness/cli.js` so `harness/exercise.js` does not import `harness/cli.js`.
9. **Knobs.** `RAD_EXERCISE_TIMEOUT_SECONDS` (default 600) bounds the whole run (Launch + agent); a malformed, zero or negative value exits 2. `RAD_EXERCISE_BLOCKING` accepts `1`/`true` (mode `blocking`) or unset/empty/`0`/`false` (mode `observe-only`); any other value exits 2. The mode only labels the summary line; the command's exit code never depends on it.
10. **Docs and invariants.** docs/rad-cli.md documents `rad exercise` (usage, resolution, the `## Exercise` block, the two env vars, output line, exit codes, "not a security sandbox: the approved plan is the control"); the env-var and exit-code tables list the new rows; the `adapter-env-allow-listed` invariant claim names `rad exercise`; `.env.example` documents both env vars.

## Agent Scope
Research came from a read-only sub-agent survey of `rad review` (harness/cli.js 3356-3533, harness/review.js), agent resolution and launch (harness/agent-select.js, harness/adapters/agent/command.js), `scripts/check-verify.sh` and `parseWaveVerify`, `scripts/worktree-lifecycle.sh`, plan section parsing, the lint advisory pattern, the plan fingerprint, and the CLI/doc registries. The anchors were spot-checked against the checkout. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/exercise.js | 1-1 | New: parser, process-group runner, `exerciseCommand` |
| harness/test/exercise.test.js | 1-1 | New: parser, runner and command tests |
| harness/cli.js | 36-46 | Import `exerciseCommand` |
| harness/cli.js | 79-100 | `EXERCISE_USAGE` next to `REVIEW_USAGE` |
| harness/cli.js | 150-162 | `exercise` entry in `SUBCOMMANDS`, injecting the review-lane agent resolution |
| harness/test/cli.test.js | 185-200 | `--help` lists `exercise` |
| docs/rad-cli.md | 599-660 | New `### rad exercise` section after `### rad review` |
| docs/rad-cli.md | 826-840 | Env-var table rows |
| docs/rad-cli.md | 950-965 | Exit-code table |
| docs/invariants.yaml | 195-200 | Extend the `adapter-env-allow-listed` claim |
| .env.example | 33-45 | Document `RAD_EXERCISE_TIMEOUT_SECONDS` and `RAD_EXERCISE_BLOCKING` |

## Execution Notes

### Do Not Touch
- harness/gates.js, harness/events.js, harness/transitions.js, harness/plan-fingerprint.js
- scripts/check-verify.sh, scripts/worktree-lifecycle.sh (use as they are)
- .rad/skills/rad-review/SKILL.md, .claude/commands/team/rad-review.md, scripts/lint-plan.sh (part 2)

### Key Files
- harness/cli.js:3356-3533 — `reviewCommand`, `resolveReviewAgent`, `reviewTimeoutMs`: the model to mirror (arg grammar, exit codes, summary line)
- harness/review.js:44 — `parseFindings` (reuse; takes the last `rad-findings` block)
- harness/adapters/agent/command.js:86,327 — `buildChildEnv` / `ENV_ALLOW_LIST` and `runCommandPrompt` (reuse)
- harness/adapters/worktree.js:30 — `makeWorktreeLifecycle`; cli.js:1280-1300 shows the wiring
- harness/cli.js:585-621 — `parseWaveVerify`, the model for a line-based section parser
- scripts/check-verify.sh — the `env -i` allow-list and the `/bin/sh -c` execution model

### Reminders
- **The worktree must be detached.** The main checkout already has `rad/<feature>` checked out, and a branch can be checked out in only one worktree. Pass the branch tip's commit SHA to `worktree-lifecycle.sh create`.
- **Launch needs its own process group.** The command adapter's spawn is not detached, so this needs new code: spawn with `detached: true`, signal `-pid`.
- **No circular import.** `harness/exercise.js` must not import `harness/cli.js`; inject the agent resolution and config loader.
- **New scripts and files:** anything executable must be committed mode 100755 (CI `shell-safety-lint`).
- **Waves run under the 10-minute agent limit**; run delivery with `RAD_WAVE_TIMEOUT_SECONDS=1800 RAD_VERIFY_TIMEOUT_SECONDS=1800`.

## Program Design

Signatures (all in `harness/exercise.js`):
```js
parseExerciseBlock(planText: string): { present, launch, teardown, drive, observes: [{ac, text}], warnings: string[] }
startLaunch({cmd, cwd, env, spawnFn}): { pid, outputTail(): string, exited(): Promise<{code}>, }
stopGroup(handle, {graceMs, killFn}): Promise<void>      // SIGTERM -pid, SIGKILL after grace
runTeardown({cmd, cwd, env, spawnFn}): Promise<{code}>
withExerciseWorktree(feature, sha, fn, {lifecycle}): Promise<any>   // create detached, run fn(dir), always remove
exerciseCommand(argv, ctx): Promise<number>               // ctx: repoRoot, resolveAgent, loadConfig, runCommandPrompt
```

Call stack for a run:
```
cli.js SUBCOMMANDS.exercise
  -> exerciseCommand
       parseExerciseBlock(plan)            -> skip (exit 0) when !present
       resolveAgent(env, config)           -> exit 2 when none
       withExerciseWorktree(feature, sha)
         startLaunch -> runCommandPrompt(agent, prompt) -> parseFindings
         finally: stopGroup -> runTeardown
       summary line + exit code
```

File tree:
```
harness/exercise.js              (new)
harness/test/exercise.test.js    (new)
harness/cli.js                   (usage + SUBCOMMANDS + import)
docs/rad-cli.md, docs/invariants.yaml, .env.example
```

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: The block parser
File: harness/exercise.js:1-1, harness/test/exercise.test.js:1-1
What: Write AC#1 and AC#2. Pure functions only (no I/O); model the line scanning on `parseWaveVerify`.
Validate: AC#1, AC#2 — `node --test harness/test/exercise.test.js` passes; edge cases covered: empty input, non-string input, no `## Exercise` section, a section with only a `Drive:`, an Observe with no AC, an AC number absent from the plan, a block ending at the next `## ` heading, a `####` sub-heading inside the block, CRLF line endings, an empty `Launch:`

### Wave 2 — sequential

#### Task 2.1: The isolated recipe runner
File: harness/exercise.js:1-1, harness/test/exercise.test.js:1-1
What: Write AC#5 (Launch, worktree) and AC#6. Add `startLaunch` (detached process group, allow-list env via `buildChildEnv`, output tail captured), `stopGroup` (SIGTERM, then SIGKILL after the grace period, on `-pid`), `runTeardown`, and the detached-worktree create/remove wrapper over `makeWorktreeLifecycle`. All injectable for tests.
Validate: AC#5, AC#6 — `node --test harness/test/exercise.test.js` passes; edge cases covered: a Launch that spawns a grandchild which must be dead after `stopGroup`, a Launch that exits 0 immediately, a Launch that exits non-zero, a Launch that never exits, a secret in the parent env not visible to Launch or Teardown, a Teardown that fails (logged, exit unchanged), the worktree removed after a failure

### Wave 3 — sequential

#### Task 3.1: The exercise command
File: harness/exercise.js:1-1, harness/test/exercise.test.js:1-1
What: Write AC#3, AC#4, AC#7, AC#8 and AC#9: `exerciseCommand(argv, ctx)` (arg grammar, `--check`, skip, the run orchestration, prompt builder, findings via `parseFindings`, summary line, exit codes, the two env knobs).
Validate: AC#3, AC#4, AC#7, AC#8, AC#9 — `node --test harness/test/exercise.test.js` passes; edge cases covered: no feature argument, a missing plan doc, `--check` on an absent block, a malformed `RAD_EXERCISE_TIMEOUT_SECONDS` (`abc`, `0`, `-5`), `RAD_EXERCISE_BLOCKING=maybe`, no agent configured, an agent that exits non-zero, a non-array `findings`, no findings block, an `error=` value with a secret-looking string sanitized

#### Task 3.2: CLI wiring
File: harness/cli.js:36-46, harness/cli.js:79-100, harness/cli.js:150-162, harness/test/cli.test.js:185-200
What: Register `rad exercise` (usage constant, `SUBCOMMANDS` entry) and inject `reviewAgentOrRefuse`-equivalent resolution and `loadConfig` into `exerciseCommand`.
Validate: AC#8 — `node --test harness/test/cli.test.js` passes with `--help` listing `exercise`; `node harness/cli.js exercise` with no argument exits 2

### Wave 4 — sequential

#### Task 4.1: Docs and invariant
File: docs/rad-cli.md:599-660, docs/rad-cli.md:826-840, docs/rad-cli.md:950-965, docs/invariants.yaml:195-200, .env.example:33-45
What: Write AC#10.
Validate: AC#10 — `grep -c 'rad exercise' docs/rad-cli.md` is non-zero; `grep -n 'rad exercise' docs/invariants.yaml` matches; `bash scripts/lint-invariants.sh` and `bash scripts/lint-claude-md.sh` pass; docs only

### Wave 5 — sequential
Final verification, run by the harness: the full set of CI-equivalent checks.

Verify: exec bash scripts/verify-all.sh

#### Task 5.1: Full verification
File: harness/exercise.js:1-1
What: The harness runs the `Verify:` command above after this task returns, so make no edits unless the harness feeds back a failure that traces to this plan's changes, and such a fix stays within the scope above. Report any other failure as `blocked_intent`.
Validate: AC#1 — the harness's Verify gate passes (`verify-all: ... 0 failed`)

## Tests to Write
- [ ] Parser: shape, warnings, absence rules, edge inputs — harness/test/exercise.test.js
- [ ] Runner: process-group kill including a grandchild, env scrubbing, Teardown failure, worktree removal on failure — harness/test/exercise.test.js
- [ ] Command: skip, `--check`, success summary line, exit 1 and exit 2 cases, both env knobs — harness/test/exercise.test.js
- [ ] `--help` lists `exercise` — harness/test/cli.test.js

## Non-Goals
- Wiring `/rad-review` Step 4c, the cycle-record `exercise` field, or `lint-plan.sh` checks (part 2).
- A real sandbox (network or filesystem isolation); the approved plan is the control, and the docs say so.
- Deduplicating findings across runs, or writing `findings.jsonl` (the review skill persists findings).
- Anything touching the approval gate, the event log or the plan fingerprint.

## Out-of-Scope Dependencies
None

## Risks
- **Process-group kill is new code.** The adapter and the Verify gate only signal the direct child. Mitigation: a grandchild-survival test in Wave 2.
- **Launch readiness is unknown to the harness.** The agent is told to wait for the artifact; a Launch that dies early is reported as exit 1.
- **Self-protected paths** (`harness/`, `docs/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — the agent resolves like the review lane** (`RAD_REVIEW_AGENT_CMD`, then `RAD_AGENT_CMD`, then config), not the deliver lane, so a different-vendor evaluator can drive the exercise.
- **Assumption — Launch is started in the background and the harness does not probe readiness;** the prompt tells the agent to wait. A Launch that exits non-zero before the agent returns fails the run; a Launch that exits 0 (a CLI artifact) is fine.
- **Assumption — the exercised commit is the committed branch tip,** so uncommitted changes in the main checkout are not exercised.
- **Assumption — a Teardown failure is logged but does not change the exit code,** since it is cleanup after a completed observation.
- **Assumption — `rad exercise --check` exists** so part 2's `lint-plan.sh` calls one parser instead of re-implementing it in bash.
- **Assumption — the skill, not the command, applies `RAD_EXERCISE_BLOCKING`;** the command only labels the mode, so its exit code stays independent of the mode.
