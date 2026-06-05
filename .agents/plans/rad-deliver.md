# Plan: rad deliver CLI subcommand
Created: 2026-06-05
Author: architect
Status: complete
Completed-At: 2026-06-05T18:20:00Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-06-05T17:44:58.705Z
Branch: rad/rad-deliver

## Context
`harness/cli.js` ships the `rad approve` subcommand (PR #19), proving the `rad
<verb>` pattern for the no-model half of RAD. `deliverSpine` in `harness/spine.js`
already accepts an injected `runWave` async function — but no CLI entry point
exists to supply a real, SDK-backed implementation. This plan wires
`@anthropic-ai/claude-agent-sdk` to that injection point, completing the CLI
with `rad deliver <feature>` and making wave execution drivable from outside the
Claude Code harness.

## Scope
| In scope | Out of scope |
|---|---|
| New `deliver` subcommand in `harness/cli.js` | `/rad-status`, `/rad-plan`, `/rad-design` CLI cutovers |
| New `harness/runwave.js` — SDK-backed runWave implementation | Removing plan-doc dual-write (Decision 2 — separate follow-up) |
| Add `@anthropic-ai/claude-agent-sdk` to `harness/package.json` | Changing `deliverSpine`, `matrix`, `gates`, or `events` internals |
| `ANTHROPIC_API_KEY` env validation before any API call | Persistent execution log format changes beyond what spine already produces |
| `node --test` coverage: dispatch, auth guard, gate refusal | Changing `scripts/*.sh` gating scripts |

## Acceptance Criteria
1. `rad deliver <feature>` (via `node harness/cli.js deliver <feature>`) reads the
   approved plan, constructs per-wave prompts from the plan definition, invokes
   `deliverSpine` with an SDK-backed `runWave`, streams wave progress to stdout,
   and exits 0 on full completion.
2. Each wave sends its prompt (following the template in
   `.claude/commands/team/rad-deliver.md`) to Claude via the Agent SDK; the
   returned WAVE_RESULT is parsed and task statuses (`complete`,
   `done_with_concerns`, `blocked_code`, `blocked_spec`, `blocked_intent`) are
   handled per the retry/escalate rules already in `deliverSpine`.
3. `ANTHROPIC_API_KEY` absent or empty → non-zero exit with a clear message
   before any SDK call is made.
4. `rad deliver` refuses with non-zero exit when `gate(feature, 'approved')` is
   not satisfied (parity with the existing prose command gate).
5. `node --test` coverage: dispatch routes to deliverCommand (AC#1 smoke),
   ANTHROPIC_API_KEY absent exits non-zero with the key name in the message
   (AC#3), unapproved plan exits non-zero before runWave is ever called (AC#4).

## Agent Scope
Explore sub-agent (research only, read-only). All wave execution within architect
scope.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/runwave.js | new file ~100 | Export createRunWave({apiKey, model, repoRoot}) → async runWave(wave, planCtx) that constructs prompt, calls SDK, streams, parses WAVE_RESULT |
| harness/cli.js | 27-35 + ~150 new | Add deliver entry to SUBCOMMANDS; parseDeliverArgs; deliverCommand |
| harness/package.json | throughout | Add @anthropic-ai/claude-agent-sdk dependency |
| harness/package-lock.json | throughout | Lockfile updated by npm install (companion to package.json dep addition) |
| harness/test/deliver.test.js | new file ~150 | node --test cases for AC#1 smoke, AC#3 auth guard, AC#4 gate refusal |
| .agents/state/rad-deliver/events.jsonl | new file | Framework state artifact written by rad approve (always travels with plan) |

## Execution Notes

### Do Not Touch
- `harness/spine.js` — deliverSpine is complete; deliverCommand composes it,
  never modifies it
- `harness/adapters/git-state-store.js` — StateStore port is complete; compose,
  don't modify
- `harness/matrix.js`, `harness/gates.js`, `harness/events.js`,
  `harness/transitions.js`, `harness/fingerprint.js` — core state machines;
  untouched by this increment
- `scripts/*.sh` — called via sh boundary; never modified
- `harness/cli.js` approveCommand — no changes to the approve subcommand

### Key Files
- `harness/spine.js` — read fully before writing deliverCommand; understand
  deliverSpine's `{runWave, sh, state, matrix}` parameter shape and its return
  value; this is the seam deliverCommand must satisfy
- `harness/cli.js` — approveCommand is the exact structural pattern for
  deliverCommand: parse → guard → compose dependencies → call core → return code
- `.claude/commands/team/rad-deliver.md` — the Step 6 wave sub-agent prompt
  template (including Guardrail Extensions protocol, task list format, per-task
  self-classification instructions, and WAVE_RESULT spec) is what runWave must
  construct and send
- `harness/adapters/git-state-store.js` — createGitStateStore(repoRoot, sh,
  claudeMd) signature used in deliverCommand
- `harness/test/cli.test.js` — withTempRepo, writePlanDoc, and mock-sh patterns
  to follow in deliver.test.js

### Reminders
- `runWave` is injected into `deliverSpine` — keep the injection seam (accept
  `runWave` as an opt in `ctx`) so tests can pass a fake without touching the SDK
- `ANTHROPIC_API_KEY` check must happen at the top of deliverCommand, before
  `createRunWave` is called — never inside the wave loop
- The wave prompt must include the Guardrail Extensions protocol from rad-deliver.md
- Do not call `process.exit()` inside deliverCommand — return an integer exit code
  (same contract as approveCommand)
- Never log or emit the API key value, even partially, in error messages or stdout
- Read `harness/spine.js` fully before Task 2.1 — the exact `deliverSpine`
  parameter shape and return structure determine deliverCommand's wiring code
- If `@anthropic-ai/claude-agent-sdk` does not provide built-in file-read/write
  tools, Task 1.2 must provide them as custom tool definitions passed to the agent

## Wave Plan

### Wave 1 — sequential
Tasks must run in sequence: runwave.js depends on the installed package.

#### Task 1.1: SDK dependency
File: harness/package.json
What: Add `"@anthropic-ai/claude-agent-sdk": "latest"` to `dependencies`. Run
`npm install` in `harness/` to update `package-lock.json`. Keep all other fields
(bin, engines, scripts, existing deps) unchanged.
Validate: AC#3 — `node -e "import('@anthropic-ai/claude-agent-sdk').then(()=>process.exit(0))"` in harness/ exits 0 (package resolves); no missing-module error.

#### Task 1.2: harness/runwave.js — SDK-backed wave runner
File: harness/runwave.js (new file)
What: Export `createRunWave({ apiKey, model, repoRoot })` which returns an async
`runWave(wave, planCtx)` function. The function must:
(1) Construct the wave prompt string from `wave` (wave number, type, tasks) and
`planCtx` (feature, branch, execution notes, AC list) following the exact template
in `.claude/commands/team/rad-deliver.md` Step 6 — include the Guardrail
Extensions protocol, per-task instructions, and WAVE_RESULT format spec.
(2) Invoke the Claude Agent SDK with the constructed prompt and `apiKey`/`model`.
If the SDK requires tool definitions for filesystem access, provide read/write/bash
tool definitions. Stream response tokens to process.stdout.
(3) Extract the WAVE_RESULT...END_WAVE_RESULT block from the response text.
(4) Parse and return `{ status, tasks: [{title, status, commit, concern, error}] }`.
(5) On SDK error (network, auth, rate-limit), return a synthetic result:
`{ status: 'failed', tasks: [{ title: wave.id, status: 'blocked_code', error: err.message }] }`.
Validate: AC#2 — given a mock SDK that returns a fixture string containing all five
task status variants (complete, done_with_concerns, blocked_code, blocked_spec,
blocked_intent), `createRunWave`'s returned function parses each status correctly.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: deliver subcommand in harness/cli.js
File: harness/cli.js (lines 27-35 + new lines)
What: Three additions, all in harness/cli.js:
(1) Add `deliver` entry to the SUBCOMMANDS table:
`{ summary: 'Run approved plan wave execution via Claude Agent SDK.', usage: 'rad deliver <feature> [--model <model-id>]', run: (argv, ctx) => deliverCommand(argv, ctx) }`.
(2) Implement `parseDeliverArgs(argv)` — positional `feature` (required),
optional `--model <id>` (default: `claude-opus-4-8`). Same throw-on-malformed
contract as parseApproveArgs.
(3) Implement `deliverCommand(argv, ctx)`:
  - Parse args; fail with usage on missing feature.
  - Check `process.env.ANTHROPIC_API_KEY` — non-empty string required; exit 1
    with `rad deliver: ANTHROPIC_API_KEY is required` if absent.
  - Resolve `planFile = join(repoRoot, '.agents', 'plans', feature + '.md')`;
    exit 1 if not found.
  - Read and parse the plan file: extract feature name, branch, execution notes
    (Do Not Touch / Key Files / Reminders), and wave definitions (wave number,
    type, array of tasks with File/What/Validate fields), AC list.
  - Gate check: `await state.gate(feature, 'approved')` — exit 1 with clear
    message if not passed.
  - Construct `runWave = createRunWave({ apiKey: process.env.ANTHROPIC_API_KEY,
    model, repoRoot })`.
  - Call `await deliverSpine({ runWave, sh, state, matrix, /* plan data */ })`.
  - On success: print structured summary line to stdout, return 0.
  - On failure: print escalation details to stderr, return 1.
Validate: AC#1, AC#3, AC#4 — `node harness/cli.js deliver --help` prints usage;
`ANTHROPIC_API_KEY="" node harness/cli.js deliver some-feature` exits 1 with
ANTHROPIC_API_KEY in the message; plan with Status: pending-review exits 1.

### Wave 3 — sequential
Depends on: Wave 2 complete

#### Task 3.1: Tests — harness/test/deliver.test.js
File: harness/test/deliver.test.js (new file)
What: Using withTempRepo and writePlanDoc helper patterns from cli.test.js, write
three node --test cases:
(a) Dispatch smoke: `main(['deliver', '--help'], { repoRoot })` exits 0; stdout
includes 'deliver' (AC#1 — no API call needed).
(b) Auth guard: call `deliverCommand(['some-feature'], { repoRoot, sh: mockSh })`
with ANTHROPIC_API_KEY unset/empty; verify exit code is 1 and stderr contains
'ANTHROPIC_API_KEY' (AC#3).
(c) Gate refusal: write a plan doc with Status: pending-review; call
`deliverCommand(['some-feature'], { repoRoot, sh: mockSh })`; verify exit code is
non-zero and runWave was never called (AC#4). Inject a spy runWave via ctx to
confirm it receives zero calls.
Validate: AC#5 — `node --test harness/test/deliver.test.js` passes all three cases
with no failures.

## Tests to Write
- [ ] dispatch routes deliver to deliverCommand (help exits 0) — harness/test/deliver.test.js
- [ ] ANTHROPIC_API_KEY absent → exits 1 with key name in message — harness/test/deliver.test.js
- [ ] unapproved plan → exits non-zero, runWave never called — harness/test/deliver.test.js

## Non-Goals
- No `/rad-status`, `/rad-plan`, or `/rad-design` CLI cutovers — separate follow-ups
- No removal of plan-doc `Status:` dual-write — Decision 2 is a separate follow-up
- No interactive tty progress bars or spinners beyond streaming SDK output to stdout
- No retry logic in deliverCommand — `deliverSpine` owns retry/escalate per the
  wave execution rules; deliverCommand only wires the dependencies

## Out-of-Scope Dependencies
None — all composed code already exists in the harness; only the SDK boundary is new.

## Risks
- `@anthropic-ai/claude-agent-sdk` API surface is not yet known. If the client
  constructor or invocation shape differs from the assumed pattern, Task 1.2 will
  need adjustment. Mitigation: Task 1.2 instructs the agent to read the SDK's
  own docs/README before writing the implementation.
- Wave agents need filesystem access (read files, write edits, run git). If the
  SDK does not provide built-in file tools, the wave agent cannot fulfill tasks.
  Mitigation: Task 1.2 explicitly handles this — provide custom tool definitions
  if built-in tools are absent.
- `deliverSpine` parameter shape may require plan data (waves, ACs) in a specific
  format not obvious from the research summary. Mitigation: spine.js is in Key
  Files and must be read in full before Task 2.1 begins.
