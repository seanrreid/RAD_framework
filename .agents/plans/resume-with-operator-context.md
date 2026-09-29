# Plan: Resume a Stopped Run with Operator Context
Created: 2026-09-29
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-29T16:58:29.441Z
Recorded-By: sean@torchcodelab.com
Branch: rad/resume-with-operator-context
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/95
Issue-Title: Surfaced runs have no re-entry: classify terminal vs dormant stops, make the operator's reply the resume context

## Context

#95 asks for four things. #151 (the stop contract) already delivered two of them:
- **Classification.** `harness/stops.js` classifies every terminal as either `needs-decision` or `failed`.
- **Recording the pause.** An audit-only `deliver-stopped` event `{class, reason, decision, wave?, action?, outcome?}` records each stop. It's absent from `PHASE_BY_TYPE`, so a re-run afterwards is legal.

This plan covers the other two: **resume with operator context** (proposal 3) and **surfacing dormant runs** (proposal 4).

**What research found:**
- **A plain re-run already resumes.** `deliverSpine` skips waves listed in `resumeFrom(history)` (`spine.js:489-524`), and a wave re-runs with a full attempt budget once its prior `wave-failed` resets `priorAttemptState` (`spine.js:567-578`, `events.js:974-989`). So `--resume` doesn't need a new re-entry mechanism. What it adds is the operator's context, a recorded `run-resumed` event, and an eligibility check.
- **`priorFailure` lives only in memory,** inside one run (`spine.js:576, 622, 867`). After a stop, the resumed run's first attempt has `priorFailure = null`. The only record of why the last run stopped is the persisted `deliver-stopped` event, so the resume block renders its `decision`/`reason`/`wave`.
- **The `priorFailure` block is not at the end of the prompt.** It's interpolated after `### Reminders` and before `## Guardrail Extensions` (`contract.js:167`). The operator-context block goes immediately after it (see Issue Gaps).
- **`failedAttemptsSinceStop` counts only `wave-attempt` events** and resets at `deliver-stopped` (`spine.js:117-124`). A new audit-only `run-resumed` event therefore can't affect `RAD_MAX_FAILED_ATTEMPTS`.
- **Gate reads happen before the spine starts.** In main-checkout mode the gate is read at `cli.js:582`. In worktree mode it's read from the branch tip at `cli.js:609`, before the worktree exists, with the same `git show` read used by `rad gate --stdin` (`cli.js:480-487`). The resume eligibility check must read the same history source.
- **`rad-status.sh` reads plans from branch tips** via `git show origin/<branch>:…` (`rad-status.sh:75-105`), but never reads event logs. `/kickoff` gets all its plan state from `rad-status.sh` (`.claude/skills/kickoff/SKILL.md:46-56`).
- **`docs/rad-cli.md:174-176` is out of date.** It lists exits 0/1 only; exits 2 and 3 are missing.

## Scope

| In scope | Out of scope |
|---|---|
| `rad deliver <feature> --resume --context "<text>"` flags + eligibility check | Reclassifying any `failed` row (e.g. doom-loop) as resumable |
| Audit-only `run-resumed` event `{context, recordedBy, stop}` | Persisting `priorFailure` across runs |
| Operator-context block in `buildWavePrompt` (first `runWave` call of a resumed run) | #112 prompt reordering / prefix-stability rework |
| `latestStop` / `dormantStop` pure read folds in `events.js` | Any change to `matrix.yaml`, `gates.yaml`, or the gate fold |
| `rad stop-status <feature> [--stdin]` read-only query | A `rad:needs-decision` host label / board mirror |
| Dormant section in `scripts/rad-status.sh` + `/kickoff` | Pausing / attended input (standing decision: the harness never pauses) |
| Docs: `rad-cli.md` (flags + full exit codes), `rad-wave-contract.md`, `harness-state-store.md` | Resume via the `/rad-deliver` skill prose (the CLI flag is the surface) |

## Acceptance Criteria

1. `rad deliver <f> --resume --context "<text>"` on a feature whose latest `deliver-stopped` has `class: needs-decision` appends one `run-resumed` event right after `deliver-started`. Its `data` is `{ context, recordedBy, stop: { class, reason, wave? } }`: `context` is byte-for-byte the argument, and `recordedBy` is `git config user.email`. The run then proceeds as a normal re-run.
2. The first `runWave` call of a resumed run renders a `## Operator Context (resumed run)` block. The block contains the prior stop's `decision`, `reason` and `wave`, plus the operator text verbatim inside a fence that can't collide with the text. It sits immediately after the `priorFailure` position (after `### Reminders`, before `## Guardrail Extensions`).
3. Later `runWave` calls in the same run (retries, later waves) do **not** render the operator-context block. A retry renders `priorFailure` exactly as today.
4. Each of these refusals exits **2** with a named reason on stderr and appends **no** event:
   - no `deliver-stopped` in history
   - latest stop is `class: failed`
   - `--resume` without `--context`
   - `--context` without `--resume`
   - empty or whitespace-only context
   - context longer than 8000 characters
   - unresolvable `git config user.email`
   - a `--context` flag with no value
5. Resume doesn't bypass any gate. If the plan is unapproved or approval changed, the existing pre-start `gate` stop fires and no `run-resumed` is appended. The between-wave approval and scope re-checks (#77) run unchanged on a resumed run.
6. `run-resumed` is audit-only: it's absent from `PHASE_BY_TYPE`, so phase folds are unchanged. It doesn't count toward `RAD_MAX_FAILED_ATTEMPTS`: a resumed run after a `failed-attempt-cap` stop starts with the counter at 0 (reset by the `deliver-stopped`), and appending `run-resumed` leaves it at 0.
7. Without `--resume`, `rad deliver` produces a byte-for-byte identical event sequence and wave prompt to today. Every existing cli, spine and contract test passes unmodified.
8. The two pure folds behave as follows:
   - `latestStop(history)` returns the latest `deliver-stopped` event's data, or `null`.
   - `dormantStop(history)` returns that data only when its class is `needs-decision` and no `deliver-started` follows it; otherwise `null`.
   - Both throw on a non-array history.
9. `rad stop-status <feature> [--stdin]` exits 0 and prints either `dormant class=needs-decision reason=<r> wave=<w|unknown> decision="<d>"` or `none`. It reads the feature log by default, or a piped JSONL log with `--stdin`. A malformed log exits 1 with the parse error, and usage errors exit 2.
10. `scripts/rad-status.sh` prints a `Dormant Runs (needs a decision)` section for each branch-tip feature where `rad stop-status --stdin` reports dormant. Each entry shows the decision and a `rad deliver <f> --resume --context "…"` hint.
    - With zero dormant features the section is omitted, and output is otherwise unchanged.
    - A feature with no event log is skipped silently, since that's the expected pre-deliver state.
    - A `stop-status` failure prints a `warning:` line naming the feature and the error. It never aborts the status run.
11. `/kickoff` lists dormant runs first, above plan statuses, with the resume hint.
12. The docs are updated:
    - `docs/rad-cli.md` documents `--resume`/`--context`, `rad stop-status`, and the full exit codes 0/1/2/3.
    - `docs/rad-wave-contract.md` gains a "Resuming a stopped run" subsection under Stop contract.
    - `docs/harness-state-store.md` lists `run-resumed` as audit-only.

## Agent Scope

- `spine-mapper` (architect) mapped the `deliverSpine` signature, the attempt loop, `stopRun`, the failed-attempt fold, the `events.js` types and helpers, and the `buildWavePrompt` template.
- `approval-command-mapper` (architect) mapped `cli.js` deliver/approve parsing, exit codes, gate read sites (main + worktree), `rad-status.sh`, `/kickoff`, `docs/rad-cli.md`, and the test entry points.
- Direct reads to confirm: `contract.js:95-216` (template), `spine.js:255-300` (`capturePriorFailure`), `cli.js:40-70` (command table).

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/events.js | 20-35 | Typedef: `run-resumed` audit-only event |
| harness/events.js | 143-167 | Comment: `run-resumed` is audit-only (absent from `PHASE_BY_TYPE`) |
| harness/events.js | 990-1024 | New pure folds `latestStop(history)`, `dormantStop(history)` |
| harness/test/events.test.js | 1240-1278 | Tests for AC#8 and the `PHASE_BY_TYPE` part of AC#6 |
| harness/adapters/agent/contract.js | 25-35 | `OPERATOR_CONTEXT_HEADING` constant |
| harness/adapters/agent/contract.js | 55-90 | New `renderOperatorContext` beside `renderPriorFailure` |
| harness/adapters/agent/contract.js | 99-130 | Destructure optional `operatorContext`; build its block |
| harness/adapters/agent/contract.js | 160-170 | Interpolate `${operatorContextBlock}` right after `${priorFailureBlock}` |
| harness/test/agent-contract.test.js | 440-472 | Tests for AC#2, AC#3 (render side), AC#7 (byte-identical when absent) |
| harness/spine.js | 440-475 | JSDoc + additive `resume = null` param; append `run-resumed` after `deliver-started` |
| harness/spine.js | 575-625 | Pass `operatorContext` in the attemptCtx of the run's first `runWave` call only |
| harness/test/spine.test.js | 1940-1964 | Tests for AC#1, AC#3, AC#5, AC#6, AC#7 (spine side) |
| harness/cli.js | 44-60 | Command table: deliver usage gains `[--resume --context <text>]`; new `stop-status` entry |
| harness/cli.js | 96-102 | `RESUME_CONTEXT_MAX_CHARS = 8000` |
| harness/cli.js | 237-258 | `parseDeliverArgs`: `--resume` (boolean), `--context <text>` |
| harness/cli.js | 600-615 | Expose the resolved history source (main log vs branch-tip log) for the eligibility check |
| harness/cli.js | 779-840 | Resume eligibility check (exit 2 before any event); resolve `recordedBy`; pass `resume` to `deliverSpine` |
| harness/cli.js | 1580-1600 | New `stopStatusCommand` (reuses `readEventsFromStdin` / feature-log read like `gateCommand`) |
| harness/test/cli.test.js | 690-729 | Tests for AC#4, AC#9, and AC#1 end-to-end with injected `runWave` |
| scripts/rad-status.sh | 275-300 | Dormant Runs section (per branch-tip feature: `git show … events.jsonl \| node harness/cli.js stop-status <f> --stdin`) |
| scripts/test-rad-status.sh | 190-208 | Fixture cases for AC#10 |
| .claude/skills/kickoff/SKILL.md | 40-70 | Dormant runs reported first, with the resume hint |
| docs/rad-cli.md | 66-180 | `--resume` / `--context`, `rad stop-status`, full exit-code table |
| docs/rad-wave-contract.md | 240-270 | "Resuming a stopped run" subsection |
| docs/harness-state-store.md | 275-290 | `run-resumed` event, audit-only; dormant fold |

## Program Design

### 1. Eligibility (CLI, before the spine; exits 2 on refusal, appends nothing)

| Condition | Result |
|---|---|
| `--resume` absent, `--context` absent | today's deliver, unchanged |
| `--context` present, `--resume` absent | exit 2 `--context requires --resume` |
| `--resume` present, `--context` absent / valueless | exit 2 `--resume requires --context "<text>"` |
| context `.trim() === ''` | exit 2 `--context must not be empty` |
| context length > 8000 | exit 2 `--context exceeds 8000 characters (<n>)` (rejected, never truncated) |
| `latestStop(history) === null` | exit 2 `nothing to resume: <f> has no deliver-stopped event` |
| `latestStop(history).class === 'failed'` | exit 2 `cannot resume a failed stop (<reason>): <decision>` |
| `git config user.email` empty/errors | exit 2 `cannot resolve git user.email for run-resumed.recordedBy` |
| latest stop `needs-decision` | proceed: `resume = { context, recordedBy, stop }` → spine |

`history` means the same source the approved gate reads: `state.history(feature)` in main-checkout mode, or the branch-tip log in worktree mode, read **before** worktree creation.

Eligibility uses `latestStop`, not `dormantStop`. A resume that crashed mid-run (it left `deliver-started` with no new stop) can be resumed again, because its latest stop is still `needs-decision`.

### 2. Signatures

```js
// harness/events.js — pure folds, throw on non-array history
export function latestStop(history)  /* → deliver-stopped .data | null */
export function dormantStop(history) /* → latestStop data if class needs-decision && no later deliver-started, else null */

// harness/spine.js — additive param; null preserves today's behavior byte-for-byte
deliverSpine({ …, resume = null /* { context, recordedBy, stop } */ })
// after deliver-started, iff resume:
{ type: 'run-resumed', actor: 'harness', recordedBy, ts, data: { context, recordedBy, stop: { class, reason, wave? } } }
// first runWave call of the run only:
runWave(wave, { attempt, priorFailure, operatorContext: { context, stop } })

// harness/adapters/agent/contract.js
function renderOperatorContext(operatorContext) /* '' when absent → template unchanged */
```

### 3. Rendered block (only on the run's first `runWave` call)

````
## Operator Context (resumed run)

The previous run stopped (needs-decision, reason: fail-timeout, wave 2):
wave 2: fail-timeout — non-deterministic failure …; retry, raise the limit, or split the wave

The operator resumed it with this input (verbatim):

```
<context>
```
````

The fence length is one more than the longest backtick run in the context, with a minimum of 3. The block owns its own blank lines, like `PRIOR_FAILURE_HEADING`.

### 4. Dormant surfacing

```
rad-status.sh
 for each origin/rad/* branch with a plan:
   git show origin/<b>:.agents/state/<f>/events.jsonl   (missing → skip, expected pre-deliver)
     | node harness/cli.js stop-status <f> --stdin
   "dormant …" → collect; "none" → skip; non-zero → "warning: stop-status <f>: <stderr>"
 collected non-empty → print "Dormant Runs (needs a decision)" section before Active Plans
```

## Execution Notes

### Do Not Touch
- harness/gates.js — the gate fold stays pure and unchanged
- harness/stops.js — classification is final; resume only reads `class`
- harness/matrix.yaml, harness/gates.yaml
- harness/transitions.js — `run-resumed` is audit-only and needs no transition rule

### Key Files
- harness/spine.js — `stopRun` (58-72), `failedAttemptsSinceStop` (117-124), attempt loop (569-625)
- harness/events.js — `PHASE_BY_TYPE` (143-167), `deliver-stopped` typedef (23-29), `priorAttemptState` (974-989)
- harness/adapters/agent/contract.js — `renderPriorFailure` (60-88) is the pattern to mirror
- harness/cli.js — `gateCommand` / `readEventsFromStdin` (1446-1580) is the pattern for `stop-status`; `setupWorktreeRun` (646-660) for the branch-tip history source
- harness/test/cli.test.js — `runDeliverCaptured()` (549-560) injects `runWave`/`sh`

### Reminders
- **Byte-for-byte guarantee (AC#7):** with `resume` null or absent, no event is added or reordered, and the prompt gains no characters. Don't add blank lines around an empty block.
- **Portability:** `rad-status.sh` changes must run under both `bash` and `/bin/bash` 3.2. No associative arrays, no `mapfile`, BSD-compatible `grep -E`/`awk`.
- **Success-line tests** that assert lint's `✓ … plan is valid` must run in the hermetic `GREPO` fixture.
- **Long final checks** exceed the 2-minute foreground timeout. Run them with `run_in_background`.
- **Never swallow errors.** A `stop-status` failure in `rad-status.sh` is logged with the feature and stderr, not dropped with `|| true`.

## Wave Plan

### Wave 1 — parallel
Tasks in this wave can run in parallel (disjoint files).

#### Task 1.1: run-resumed event + stop folds
File: harness/events.js:20-35, 143-167, 990-1024, harness/test/events.test.js:1240-1278
What: Add the `run-resumed` typedef to the event typedef and document it as audit-only in the `PHASE_BY_TYPE` comment, without adding it to the map. Add `latestStop(history)` and `dormantStop(history)` per Program Design §2. Both are pure and throw `Error('latestStop: history must be an array')` (or the same for `dormantStop`) on non-array input.
Tests:
- empty history → both `null`
- only `failed` stop → `latestStop` returns it, `dormantStop` `null`
- `needs-decision` stop → both return it
- `needs-decision` stop followed by `deliver-started` → `dormantStop` `null`, `latestStop` still returns it
- two stops → the latest wins
- non-array → throws
- `PHASE_BY_TYPE` has no `run-resumed` key
Validate: AC#8, AC#6 — `npm test --prefix harness`.

#### Task 1.2: Operator-context prompt block
File: harness/adapters/agent/contract.js:25-35, 55-90, 99-130, 160-170, harness/test/agent-contract.test.js:440-472
What: Add `OPERATOR_CONTEXT_HEADING = '## Operator Context (resumed run)'` and `renderOperatorContext(operatorContext)`, following Program Design §3. It returns `''` for null or undefined. The fence is one more than the longest backtick run in the context (minimum 3), and the context is never trimmed, truncated or escaped. In `buildWavePrompt`, destructure `operatorContext = null` and interpolate `${operatorContextBlock}` immediately after `${priorFailureBlock}`.
Tests:
- absent → prompt byte-identical to the current output (snapshot-compare against a call without the key)
- present → block after the Reminders/`priorFailure` position and before `## Guardrail Extensions`
- context containing a triple-backtick run → the fence grows
- both `priorFailure` and `operatorContext` → `priorFailure` first
- missing `stop.wave` → `wave unknown`
Validate: AC#2, AC#3, AC#7 — `npm test --prefix harness`.

### Wave 2 — sequential
Task 2.2 depends on the spine param from 2.1.

#### Task 2.1: Spine resume param
File: harness/spine.js:440-475, 575-625, harness/test/spine.test.js:1940-1964
What: Add the additive `resume = null` param to `deliverSpine`. When it's set, append `run-resumed` (Program Design §2) immediately after `deliver-started`. Nothing is appended when the pre-start gate refuses. Track a run-local `operatorContextPending = Boolean(resume)`: the first `runWave` call gets `operatorContext: { context, stop }` and clears the flag, and every later call omits the key.
Tests (injected `runWave` capturing its attemptCtx):
- resume set → `run-resumed` directly after `deliver-started`, with verbatim context
- first call carries `operatorContext`; a retry of the same wave and the next wave's call don't
- unapproved gate with resume → no `run-resumed`, gate stop
- after a `failed-attempt-cap` stop plus a resume → `failedAttemptsSinceStop` is 0 and the cap isn't re-tripped immediately
- `resume` null → event sequence deep-equals the existing no-resume fixture run
Validate: AC#1, AC#3, AC#5, AC#6, AC#7 — `npm test --prefix harness`.

#### Task 2.2: CLI flags, eligibility, stop-status
File: harness/cli.js:44-60, 96-102, 237-258, 600-615, 779-840, 1580-1600, harness/test/cli.test.js:690-729
What:
- `parseDeliverArgs` accepts `--resume` (boolean) and `--context <text>`. A missing value throws, which becomes exit 2.
- Add `RESUME_CONTEXT_MAX_CHARS = 8000`.
- In `deliverCommand`, run the Program Design §1 eligibility table in order, against the same history source the gate reads (branch tip in worktree mode, before worktree creation). Every refusal exits 2 before any event is appended.
- Resolve `recordedBy` from `git config user.email` through the injected `sh`, and pass `resume` to `deliverSpine`.
- Add the `stop-status` command (table entry + `stopStatusCommand`), modelled on `gateCommand`. It prints the AC#9 line from `dormantStop`, reads the feature log or `--stdin`, exits 1 on a parse error with the message, and exits 2 on usage errors.
Tests:
- each AC#4 refusal → exit 2, stderr names the reason, log unchanged
- happy path through `runDeliverCaptured` → exit per the run outcome, `run-resumed` present
- `stop-status` → dormant / none / after `deliver-started` / malformed stdin (exit 1) / missing feature arg (exit 2)
Validate: AC#1, AC#4, AC#9 — `npm test --prefix harness`.

### Wave 3 — parallel
Tasks in this wave can run in parallel (disjoint files).

#### Task 3.1: Dormant runs in rad-status + kickoff
File: scripts/rad-status.sh:275-300, scripts/test-rad-status.sh:190-208, .claude/skills/kickoff/SKILL.md:40-70
What: Implement Program Design §4 in `rad-status.sh`, printing the `Dormant Runs (needs a decision)` section before Active Plans only when at least one feature is dormant. Update `/kickoff` to report dormant runs first, with the resume hint.
Fixture cases in `test-rad-status.sh`, using the existing local-origin fixture:
- a branch with a `needs-decision` log → section present with hint
- a branch with a `failed` log → absent
- a `needs-decision` log followed by `deliver-started` → absent
- no dormant → output identical to before, with no section header
- a corrupt log → `warning:` line naming the feature, exit 0
Run the test under `bash` and `/bin/bash`.
Validate: AC#10, AC#11 — `bash scripts/test-rad-status.sh && /bin/bash scripts/test-rad-status.sh`. The kickoff prose has no testable surface, so review it by reading.

#### Task 3.2: Docs
File: docs/rad-cli.md:66-180, docs/rad-wave-contract.md:240-270, docs/harness-state-store.md:275-290
What:
- `rad-cli.md`: document the `--resume` / `--context` flags, the eligibility table and `rad stop-status`, and replace the incomplete exit-code sentence with a 0/1/2/3 table.
- `rad-wave-contract.md`: add a "Resuming a stopped run" subsection covering `needs-decision` only, context verbatim on the first `runWave` call, and no gate bypass.
- `harness-state-store.md`: add `run-resumed` to the audit-only events, plus the `dormantStop` fold.
Validate: AC#12 — no testable surface (docs). Review by reading; `grep -n "run-resumed" docs/harness-state-store.md` and `grep -n -- "--resume" docs/rad-cli.md` are non-empty.

## Tests to Write
- [ ] `latestStop` / `dormantStop` folds + `PHASE_BY_TYPE` exclusion — harness/test/events.test.js
- [ ] `renderOperatorContext` placement, fence growth, absent-is-byte-identical — harness/test/agent-contract.test.js
- [ ] Spine `run-resumed` ordering, first-call-only context, gate refusal appends nothing, cap not re-tripped, null-resume sequence identical — harness/test/spine.test.js
- [ ] CLI eligibility refusals (exit 2, no event), resume happy path, `stop-status` outputs — harness/test/cli.test.js
- [ ] Dormant section present/absent/warning cases under bash + /bin/bash — scripts/test-rad-status.sh

## Non-Goals
- Making any `failed`-class stop resumable. Doom-loop and budget stay terminal. Revisit a row only if real use shows it matters.
- Persisting `priorFailure` across runs. The resumed run renders the persisted `deliver-stopped` decision instead.
- Reordering the wave prompt for prefix stability (#112 stays iceboxed).
- A host-platform `rad:needs-decision` label or board mirror.
- Summarizing, trimming or truncating the operator's context. It's rejected over the cap, never shortened.

## Out-of-Scope Dependencies
None. All touched paths are architect-owned, and the author is the architect.

## Risks
- **Prompt byte-stability.** An off-by-one blank line around the empty block would change every existing prompt. Guarded by the absent-is-byte-identical test in Task 1.2.
- **Worktree-mode history source.** Checking eligibility against the main-tree log in worktree mode would wrongly refuse (or allow). Task 2.2 must reuse the branch-tip read, and a test covers worktree mode through the injected `sh`.
- **`rad-status.sh` cost.** One `node` spawn per branch-tip feature that has a log. That's acceptable at today's scale (a handful of `rad/*` branches), and features without a log spawn nothing.
- **Self-protected paths.** `harness/`, `scripts/` and `.claude/` trigger advisory lint warnings by design. They need architect review but no waiver.

## Issue Gaps
- **ASSUMPTION — `surface`/`abort` mapping.** #95 frames the split as the matrix actions `surface`/`abort`. #151 generalised it to `needs-decision`/`failed` classes that cover every terminal. This plan gates on `class`, so token-budget, failed-attempt-cap and approval-changed stops are resumable too, and doom-loop, budget, post-check and resume-verify are not. Architect decision, 2026-09-29.
- **ASSUMPTION — `--context` is required and non-empty.** #95 allowed resuming with no context. Without it, `--resume` is just today's re-run. Architect decision, 2026-09-29.
- **ASSUMPTION — anyone may resume.** `run-resumed` carries `recordedBy` for audit and has no authority. Architect decision, 2026-09-29.
- **ASSUMPTION — block placement.** The resume request said "at the prompt tail", but the `priorFailure` block is actually mid-prompt (`contract.js:167`). The plan keeps the settled relation (immediately after `priorFailure`) rather than moving both to the end, which would be #112's reorder.
- **ASSUMPTION — "first attempt of the resumed wave".** This is implemented as "the first `runWave` call of the resumed run", which is attempt 1 of the first non-completed wave in practice. It stays well defined if an orphan convergence (#119) shifts attempt numbering.
- **ASSUMPTION — 8000-character context cap.** Over-cap input is rejected (exit 2), never truncated, to honour "recorded verbatim, never summarized". 8000 matches the verify excerpt byte cap.
- **ASSUMPTION — eligibility vs dormant.** Eligibility uses `latestStop`, so a crashed resumed run can be resumed again. The dormant listing uses `dormantStop`, which is hidden once any `deliver-started` follows the stop. The first favours recoverability; the second avoids listing a run that someone already picked up.
- **ASSUMPTION — `rad stop-status` as the fold's shell surface.** It follows the `rad gate --stdin` pattern so `rad-status.sh` never parses JSONL itself.
