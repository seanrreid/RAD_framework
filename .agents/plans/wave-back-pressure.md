# Plan: Per-Wave Back-Pressure Contract
Created: 2026-08-06
Author: architect
Status: pending-review
Branch: rad/wave-back-pressure
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/89
Issue-Title: Per-wave back-pressure contract: make wave self-verification a deterministic, event-recorded fact

## Context

RAD already runs a deterministic gate after every wave whose outcome would advance
(`harness/spine.js:304-305`) and demotes `success` → `fail-tests` through the matrix. But
the signal flowing through that gate is `scripts/check-tests-present.sh` — a
**file-presence** check. A wave can create every promised test file, have all of them fail,
and the gate passes. The only thing that actually *executes* verification is the wave agent,
following prose in the wave prompt (`harness/adapters/agent/contract.js:22`),
self-classifying the result. The harness
never sees the command, never runs it, never sees its output — it trusts the agent's
self-report. That is the trusted-prose pattern the deliver gate exists to eliminate
everywhere else in RAD.

Compounding it: every retry rebuilds an identical prompt (`harness/spine.js:253` calls
`runWave(wave)` with `planCtx` bound once for the whole deliver), so a retry differs from
its predecessor only by model nondeterminism. RAD built a doom-loop detector
(`harness/spine.js:390`) for a loop its own retry path structurally guarantees.

Full analysis, four design decision points, and their recommendations:
`.agents/research/wave-back-pressure.md`.

## Scope

| In scope | Out of scope |
|---|---|
| Per-wave `Verify:` declaration parsed deterministically from the plan | Per-*task* verification granularity (research D1 option (a)) |
| Harness-executed verification via a new `scripts/check-verify.sh` through the spine's injected `sh` port | Executing arbitrary commands inside `spine.js` directly |
| Failure excerpt + blocking-task status threaded into the next attempt's prompt | Changing the retry policy, `MAX_ATTEMPTS`, or the doom-loop breaker |
| `wave-attempt` gains optional `verify` **and** `tasks` keys, designed as one shape change (folds #63's contract substrate — see #89 comment) | #63's read side: `blockedReasonCounts`, the `/rad-insights` subsection, failed-wave transcript snapshots |
| Contract-level `usage` documentation + `tasks[]` pass-through in both adapters | Adding an eighth outcome; the 7-outcome vocabulary is frozen |
| `check-tests-present.sh` remains as a distinct presence gate | Removing or merging the presence gate (research Open Question 1 — resolved: keep, per #91) |

## Acceptance Criteria
<!-- Numbered, testable outcomes. Every Wave task's Validate: field must cite one. -->
1. A `### Wave N` block may carry an optional `Verify: <command>` line, parsed into a
   wave-number-keyed map; a plan with no `Verify:` line anywhere produces a
   **byte-for-byte identical** event sequence to today.
2. When a wave declares `Verify:`, the harness executes it through `scripts/check-verify.sh`
   via the spine's existing `sh` port; `spine.js` never invokes arbitrary shell directly, and
   the command runs under the adapters' allow-listed-env treatment.
3. A failing declared verification demotes the wave outcome to the existing `fail-tests`
   through `resolveOutcome`; the frozen 7-outcome vocabulary gains no member.
4. On a failing attempt, the next attempt's prompt carries a `## Prior Attempt Failure`
   section containing a truncated output excerpt (hard cap at a named constant) and the
   blocking task's reported status.
5. `wave-attempt` event `data` carries optional `verify: {command, status, passed}` and
   optional `tasks: [{title, status}]`; every existing fold (`outcomeCounts`,
   `failReasonCounts`, `retryCounts`, `totalUsage`, `reduce`, `resumeFrom`) returns
   identical results on historical logs that lack both keys.
6. `docs/rad-wave-contract.md` documents `usage` and the `tasks[]` pass-through as
   contract fields; both adapters emit them, and a malformed or absent `tasks` degrades to
   omission — never `fail-protocol`.

## Agent Scope

No research agents were called — this plan consumes the pre-existing feature-scoped
research artifact `.agents/research/wave-back-pressure.md` (architect-authored,
2026-08-04) in place of a fresh Explore sweep. The artifact carries verified `file:line`
anchors; anchors below were re-verified against post-#100 `main` on 2026-08-06.

Touches self-protected paths (`^harness/`, `^scripts/`) — architect-only, never
auto-clearable by severity routing.

## Files in Scope
<!-- Lines must be a range (e.g. 45-120) or a single number. The linter sums
     these to compute context budget. Warn at 800 lines, error at 1500. -->
| File | Lines | Change |
|------|-------|--------|
| docs/rad-wave-contract.md | 19-50 | Document `usage` and `tasks[]` as contract-specified (adapter-optional) result fields |
| docs/rad-wave-contract.md | 103-124 | Note that per-task statuses survive the outcome mapping rather than being collapsed |
| harness/adapters/agent/contract.js | 169-246 | `parseWaveResult` result threads `tasks` onto the returned shape; malformed degrades to omission |
| harness/adapters/agent/contract.js | 22-136 | `buildWavePrompt` renders an optional `## Prior Attempt Failure` section |
| harness/adapters/agent/contract.js | 137-168 | Named truncation-cap constant for the failure excerpt |
| harness/adapters/agent/command.js | 240-270 | Return `tasks` + normalized `usage` on the wave result |
| harness/adapters/agent/sdk.js | 1-60 | Return `tasks` + normalized `usage` on the wave result |
| harness/events.js | 16-50 | Typedef: `wave-attempt` data optional `tasks` and `verify` keys |
| harness/spine.js | 300-345 | Invoke declared verification at the gate site; record `verify:` on the wave-attempt event |
| harness/spine.js | 246-260 | Widen the `runWave` call to pass `{ attempt, priorFailure }` |
| harness/spine.js | 360-410 | Capture the failing attempt's excerpt + blocking task into `priorFailure` |
| harness/cli.js | 256-292 | `parseWaveVerify`, mirroring `parseWaveModels` exactly |
| harness/cli.js | 416-440 | Widen the `runWave` binding to forward the second argument |
| scripts/check-verify.sh | new | Execute a declared command under allow-listed env; bounded output capture; exit-code passthrough |
| scripts/test-check-verify.sh | new | Behavior cases with explicit exit codes |
| harness/test/spine.test.js | new cases | Absent-`Verify:` parity, failure demotion, `priorFailure` threading |
| harness/test/events.test.js | new cases | Fold parity on historical logs lacking both new keys |
| harness/test/agent-contract.test.js | new cases | `tasks` pass-through, malformed degradation, prompt section rendering |
| harness/test/cli.test.js | new cases | `parseWaveVerify` parsing and absence |
| CLAUDE.md | 1 | Document the per-wave `Verify:` line alongside `Model:` |

## Issue Gaps
<!-- Assumptions this plan makes that #89 did not specify. -->

The issue is unusually well-specified — it carries a research artifact with four decision
points and recommendations. These are the assumptions the plan adds on top:

- **All four D-recommendations are adopted as written**: D1(b) per-wave `Verify:` line,
   D2(c) new `scripts/check-verify.sh` through the `sh` port, D3(a) widen `runWave`
   additively, D4 ride the existing `wave-attempt` event. The issue presented these as
   recommendations, not decisions; this plan treats them as decided.
- **#63's contract substrate is folded in** (Waves 1–2), per the architect decision
   recorded at #89's comment thread. The issue's Related section said "sequence
   deliberately" without choosing; this plan chooses, and states what stays in #63.
- **Open Question 1 is resolved as "yes"** — `check-tests-present.sh` stays as a distinct
   presence gate. Presence and behavior catch different failure modes (#91).
- **Open Question 2 (composition when a wave declares no `Verify:` but its tasks do)
   is sidestepped**, not answered: per-task declaration is out of scope, so no composition
   rule is needed. If per-task `Verify:` is added later, that plan owns the rule.
- **Open Question 3 (timeout) is deferred.** `check-verify.sh` inherits whatever timeout
   the `sh` port already applies; no declarable per-command timeout is added. Flagged as a
   follow-up rather than silently assumed away.
- **Open Question 4 (`RAD_WORKTREE` interaction) is assumed handled by cwd inheritance** —
   `check-verify.sh` runs through the same `sh` port the other scripts use, which already
   resolves to the worktree checkout when isolation is active. Task 3.2 should assert this
   rather than assume it.
- **The truncation cap value is not specified by the issue.** This plan requires it to be a
   named constant but does not fix the number; the delivering wave picks it and the
   architect reviews it at Gate 2.

## Program Design

### 1. Signatures introduced or altered

```js
// harness/cli.js — new, mirrors parseWaveModels exactly
function parseWaveVerify(text): Record<number, string>

// harness/spine.js — call site widened (additive second argument)
runWave(wave)  →  runWave(wave, { attempt: number, priorFailure?: PriorFailure })

// harness/adapters/agent/contract.js — new optional prompt input
buildWavePrompt(wave, planCtx, priorFailure?: PriorFailure): string

/** @typedef {{ excerpt: string, blockingTask?: { title: string, status: string } }} PriorFailure */

// wave result shape — two fields promoted to contract-specified (both adapter-optional)
{ status, tasks?: [{ title, status }], usage?: { input, output, total }, ... }

// wave-attempt event data — two optional keys, designed together
{ wave, outcome, usage?, tasks?: [{title,status}], verify?: { command, status, passed } }
```

```bash
# scripts/check-verify.sh — new
scripts/check-verify.sh <feature> <command>
#   exit 0   = command passed; output discarded
#   exit non-zero = command failed; bounded excerpt on stdout
```

### 2. Control-flow sketch

```
deliverSpine (harness/spine.js)
 └─ for each wave
     └─ for attempt 1..MAX_ATTEMPTS
         ├─ fireHooks('pre-wave')                         [unchanged]
         ├─ runWave(wave, { attempt, priorFailure })      ← WIDENED (Wave 4)
         │   └─ adapter → buildWavePrompt(wave, planCtx, priorFailure)
         │                 └─ renders "## Prior Attempt Failure" when present
         │   └─ parseWaveResult → { status, tasks[], usage }   ← tasks THREADED (Wave 1)
         ├─ resolveOutcome('implement', outcome, matrix)  [unchanged, 7 tokens]
         ├─ if action would advance:
         │    ├─ sh('scripts/check-tests-present.sh')     [unchanged presence gate]
         │    └─ if wave declares Verify:                 ← NEW (Wave 3)
         │         └─ sh('scripts/check-verify.sh', feature, cmd)
         │            └─ non-zero → demote outcome to 'fail-tests' via matrix
         ├─ append 'wave-attempt' { …, tasks?, verify? }  ← ENRICHED (Waves 2,3)
         └─ on retry/revision:
              ├─ fingerprint(gated) → doom-loop breaker   [unchanged]
              └─ priorFailure = { excerpt, blockingTask } ← NEW (Wave 4)
```

The matrix remains the sole authority on "what happens next" — verification only supplies a
different *input* token (`fail-tests`), never a new branch in `spine.js`.

### 3. File-tree diff

```
 harness/
   spine.js                        M   gate site, runWave call, priorFailure capture
   cli.js                          M   parseWaveVerify, runWave binding
   events.js                       M   typedef only (no fold changes)
   adapters/agent/
     contract.js                   M   tasks threading, prompt section, cap constant
     command.js                    M   return tasks + usage
     sdk.js                        M   return tasks + usage
   test/
     spine.test.js                 M   parity, demotion, threading
     events.test.js                M   fold parity on historical logs
     agent-contract.test.js        M   pass-through, malformed degradation
     cli.test.js                   M   parseWaveVerify
 scripts/
   check-verify.sh                 +   NEW — declared-command executor
   test-check-verify.sh            +   NEW — behavior cases
 docs/
   rad-wave-contract.md            M   usage + tasks[] documented
 CLAUDE.md                         M   per-wave Verify: line

 (none deleted, none moved)
```

## Execution Notes

### Do Not Touch
- `harness/gates.js` — must stay a pure fold. Verification attaches at the spine/script
  boundary, never inside the fold (the rule `RAD_SYNC` established).
- `harness/matrix.yaml` — the 7-outcome vocabulary is frozen. A verification failure maps
  to the existing `fail-tests`; granularity is *recorded*, not *routed on*.
- `scripts/check-tests-present.sh` — the presence gate stays as-is and distinct (#91).
- `.agents/research/*.md`, `.agents/plans/*.md` — historical records (architect decision,
  2026-08-05); do not rewrite.
- `harness/events.js` `reduce()` fold semantics — append a typedef field only; no fold may
  change behavior on historical logs.

### Key Files
- `.agents/research/wave-back-pressure.md` — the design record; read D1–D4 before starting
- `harness/cli.js:270-292` — `parseWaveModels` is the exact structural precedent for
  `parseWaveVerify`; copy its block-scoping rules (deeper `####` headings stay inside the wave)
- `harness/adapters/agent/contract.js:314` — `normalizeUsage` already exists; Wave 1
  documents it, it is not being written
- `docs/rad-wave-contract.md` — the provider-neutral contract both adapters must satisfy
- `scripts/hooks/README.md` — the invocation-contract style `check-verify.sh` should follow

### Reminders
- Wave 1 and Wave 2 are the substrate folded from #63 (see the #89 comment). #63 stays open
  for its read side; do not implement `blockedReasonCounts` or the `/rad-insights`
  subsection here.
- Every new event key is **optional**. The parity test in Task 2.3 is the gate on that claim
  — write it before Wave 3 builds on the shape.
- Declared verification commands are arbitrary shell from a human-approved plan. The trust
  boundary is unchanged, but the execution path needs the allow-listed-env treatment the
  adapters already use (`docs/rad-wave-contract.md`, "Never leak credentials").
- Truncation is mandatory, not best-effort. An untruncated failing suite in the retry prompt
  reproduces the exact context flood this feature exists to prevent.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence: the contract doc defines the shape the adapters implement.

#### Task 1.1: Document `usage` and `tasks[]` in the wave contract
File: docs/rad-wave-contract.md:19-50, 103-124
What: Add `usage` (adapter-optional, contract-specified) and `tasks[]` to the adapter
interface's return-shape table. Note in the result→outcome section that per-task statuses
are passed through rather than collapsed at the mapping.
Validate: AC#6 — the return-shape table lists both fields with their optionality stated.

#### Task 1.2: Thread parsed `tasks` onto the wave result
File: harness/adapters/agent/contract.js:169-246
What: `parseWaveResult` already builds per-task `{title, status}`; surface it on the
returned result shape so it survives to the spine. A malformed or absent `tasks` block
yields omission of the key, never a thrown error or `fail-protocol`.
Validate: AC#6 — a wave result with no parseable tasks maps to the identical outcome it
maps to today; a malformed block omits the key rather than failing.

#### Task 1.3: Both adapters return `tasks` + normalized `usage`
File: harness/adapters/agent/
What: Both adapters — `command.js:240-270` and `sdk.js:1-60` — populate `tasks` and `usage`
(via the existing `normalizeUsage`) on the result they return to the spine.
Validate: AC#6 — an adapter reporting no usage still maps outcomes identically and
contributes 0 to the budget, exactly as today.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Event typedef gains both optional keys
File: harness/events.js:16-50
What: Document `wave-attempt` `data` optional keys `tasks: [{title, status}]` and
`verify: {command, status, passed}` in the Event typedef. Designed together as one shape
change so #67's replay check gates one change, not two.
Validate: AC#5 — the typedef declares both keys optional; no fold code changes in this task.

#### Task 2.2: Spine records `tasks` on the wave-attempt event
File: harness/spine.js:300-345
What: When the wave result carries `tasks`, include it in the `wave-attempt` event `data`;
omit the key entirely when absent — mirroring exactly how `usage` is handled today.
Validate: AC#5 — a result without `tasks` appends an event byte-identical to today's.

#### Task 2.3: Fold-parity test on historical logs
File: harness/test/events.test.js
What: Prove every existing fold (`outcomeCounts`, `failReasonCounts`, `retryCounts`,
`totalUsage`, `reduce`, `resumeFrom`) returns identical results on a historical log that
lacks both new keys. This is the gate on the "additive at parity" claim.
Validate: AC#5 — folds over a fixture log with no `tasks`/`verify` keys match the
pre-change expected values exactly.

### Wave 3 — sequential
Depends on: Wave 2 complete

#### Task 3.1: Parse the per-wave `Verify:` line
File: harness/cli.js:256-292
What: Add `parseWaveVerify`, structurally mirroring `parseWaveModels` — same wave-block
scoping, same "deeper `####` headings stay inside the wave" rule, keyed by wave number.
Absent line ⇒ wave absent from the map.
Validate: AC#1 — a plan with no `Verify:` line yields an empty map; a plan with one yields
exactly that wave's command.

#### Task 3.2: New `scripts/check-verify.sh`
File: scripts/check-verify.sh
What: Execute the declared command under the adapters' allow-listed-env treatment, capture
output bounded by a named constant, and pass the command's exit code through. Keeps
arbitrary execution out of `spine.js`, keeps the `sh` port shape unchanged.
Validate: AC#2 — a passing command exits 0 with output discarded; a failing command exits
non-zero with a bounded excerpt on stdout.

#### Task 3.3: Spine invokes verification and records the result
File: harness/spine.js:300-345
What: At the existing gate site, when the wave declares `Verify:`, invoke
`scripts/check-verify.sh` through the injected `sh` port. Failure demotes to `fail-tests`
via `resolveOutcome`. Record `verify: {command, status, passed}` on the wave-attempt event.
Validate: AC#2, AC#3 — a failing verification produces `fail-tests` through the matrix and
a `wave-attempt` event carrying `verify.passed: false`; no new outcome token appears.

### Wave 4 — sequential
Depends on: Wave 3 complete

#### Task 4.1: Widen `runWave` to accept attempt context
File: harness/spine.js:246-260
What: Change the spine's call to `runWave(wave, { attempt, priorFailure })` and widen the
`harness/cli.js:416-440` binding to forward the second argument. Additive: an adapter
ignoring it behaves exactly as today.
Validate: AC#4 — an adapter that ignores the second argument produces today's behavior
unchanged.

#### Task 4.2: Render the `## Prior Attempt Failure` prompt section
File: harness/adapters/agent/contract.js:22-136, 137-168
What: `buildWavePrompt` renders an optional `## Prior Attempt Failure` section when
`priorFailure` is present, carrying the truncated excerpt and the blocking task's status.
Truncation cap is a named constant, applied unconditionally.
Validate: AC#4 — absent `priorFailure` renders today's prompt byte-for-byte; present
`priorFailure` renders the section with output truncated at the cap.

#### Task 4.3: Capture the failing attempt into `priorFailure`
File: harness/spine.js:360-410
What: In the retry/revision branch, build `priorFailure` from the failing attempt's
verification excerpt and the blocking task's reported status, and carry it into the next
iteration. Does not alter the doom-loop breaker or `MAX_ATTEMPTS`.
Validate: AC#4 — attempt 2's prompt contains attempt 1's failure context; the doom-loop
fingerprint logic is untouched.

### Wave 5 — sequential
Depends on: Wave 4 complete

#### Task 5.1: Spine and CLI test coverage
File: harness/test/spine.test.js
What: Absent-`Verify:` event-sequence parity, verification failure demotion, and
`priorFailure` threading across attempts; plus `parseWaveVerify` parsing/absence in
`harness/test/cli.test.js`.
Validate: AC#1, AC#2, AC#3, AC#4 — each has at least one explicit case, including the
absent-declaration parity case.

#### Task 5.2: `scripts/test-check-verify.sh`
File: scripts/test-check-verify.sh
What: Behavior cases with explicit exit codes: passing command, failing command, output
exceeding the truncation cap, missing command, and a command that writes to stderr only.
Validate: AC#2 — five cases with asserted exit codes and bounded output.

#### Task 5.3: Document the `Verify:` line
File: CLAUDE.md:1, harness/test/agent-contract.test.js
What: Document the per-wave `Verify:` line in the RAD Configuration block alongside
`Model:`, stating the absent-declaration guarantee. Add contract tests for `tasks`
pass-through and malformed degradation.
Validate: AC#1, AC#6 — the config block states the opt-in and the byte-identical
absent-declaration guarantee; contract tests cover pass-through and malformed input.

## Tests to Write
- [ ] Absent `Verify:` produces a byte-identical event sequence — harness/test/spine.test.js
- [ ] Failing verification demotes to fail-tests through the matrix — harness/test/spine.test.js
- [ ] `priorFailure` reaches attempt 2's prompt, truncated at the cap — harness/test/spine.test.js
- [ ] Existing folds return identical results on logs lacking both keys — harness/test/events.test.js
- [ ] `tasks` pass-through and malformed-block degradation — harness/test/agent-contract.test.js
- [ ] `parseWaveVerify` parses a declared line and omits absent waves — harness/test/cli.test.js
- [ ] check-verify.sh behavior cases with explicit exit codes — scripts/test-check-verify.sh

## Non-Goals
- Per-task verification granularity — the gate runs per wave; per-task is research D1(a), rejected.
- Replacing or removing `check-tests-present.sh` — presence and behavior catch different
  failure modes; both gates are worth having (#91).
- #63's read side — `blockedReasonCounts`, the `/rad-insights` subsection, and failed-wave
  transcript snapshots stay in #63.
- Changing retry policy, `MAX_ATTEMPTS`, or the doom-loop breaker — this plan makes retries
  *differ*, it does not change how many there are.
- Adding an eighth outcome to the frozen matrix vocabulary.

## Out-of-Scope Dependencies

None. Touches self-protected paths (`^harness/`, `^scripts/`), so this plan is architect-only
and can never be auto-cleared by severity routing — that is the intended path, not a blocker.

## Risks

- **Event-shape change interacts with #67** (event-log replay regression check). Both new keys
  are optional and Task 2.3 is the explicit parity gate, but #67 landing later must re-verify.
- **Arbitrary shell from a plan file.** The plan is human-approved so the trust boundary is
  unchanged, but `check-verify.sh` must apply the allow-listed-env treatment or it becomes a
  credential-leak path. This is the highest-risk task in the plan (3.2).
- **Prompt-shape change affects every adapter.** The `## Prior Attempt Failure` section is
  additive and absent by default, but an adapter that re-parses the prompt could be affected.
- **Truncation cap is a judgment call.** Too small loses the actionable error; too large
  reproduces the context flood. The constant should be named and easy to revisit.
- **Wave 4 widens the provider-neutral contract.** Additive, and `docs/rad-wave-contract.md`
  already defines `runWave(wave, planCtx)` as two-argument — but any out-of-tree adapter that
  hard-codes arity would need updating.
