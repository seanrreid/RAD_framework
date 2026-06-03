# Plan: Pure-fold gate + write-time role authority
Created: 2026-06-02
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-06-02T19:37:42Z
Branch: rad/harness-gate-pure-fold

## Context
The `approved` gate currently checks authority at READ-time in two places that
contradict each other: `gates.js`'s rule wants `actor === 'architect'` (the role
token), while `git-state-store.js` `gate()` then re-runs `check-role.sh` on that
same `actor` (which expects a real identity) — so no `actor` value satisfies both
(the step-1 unit test only passes by mocking `sh` to return 0). This blocks the
halted `approve` CLI (`rad/harness-cli-approve`, AC#2's gate-passes-green clause).
The fix follows the settled principle: **check authority once, at write-time,
freeze the result into the event; everything downstream just reads.** The gate
becomes a pure fold over the event log; the role check moves into `recordApproval`.

## Scope
| In scope | Out of scope |
|---|---|
| `approved` event gains a verified `role` field; `actor` becomes human identity | Removing the plan-doc `Status:` dual-write from the CLI / `/rad-approve` (Decision 2 full cutover — later) |
| `recordApproval` runs `check-role.sh` at write-time and freezes the verdict into `role` | Modifying the CLI on `rad/harness-cli-approve` (separate branch; rebases on top after this lands) |
| `validateTransition` rejects an `approved` event lacking a verified `role` | Deleting `scripts/check-plan-approved.sh` (kept as a transitional compat shim) |
| `gate('approved')` becomes a pure fold — no read-time shell-outs | Changing `spine.js`, `matrix.js`, or the StateStore public interface |
| `gates.yaml` + `evaluateGate` decide on `role`; update the affected harness tests | `/rad-deliver` prose Step 2 (it keeps its own `check-plan-approved.sh` call) |

## Acceptance Criteria
<!-- Numbered, testable outcomes. Every Wave task's Validate: field must cite one. -->
1. The `approved` event carries the approver's human identity in `actor` and a
   separate `role` field holding the verified role token; `reduce()` exposes
   `role` on collected approvals.
2. `recordApproval` verifies the approver's role via `check-role.sh` at write-time
   and freezes the verdict into the event's `role`; it refuses (throws, writes
   nothing) when the role check fails. `validateTransition` rejects an `approved`
   event that lacks a `role` — so the authority cannot be bypassed by calling
   `append()` directly.
3. `gate('approved')` is a pure fold over the event log: it performs NO shell-out
   (no `check-role.sh`, no `check-plan-approved.sh`) and decides solely from event
   history — an `approved` event with `role == architect` passes; one missing/with
   a wrong role fails.
4. `gates.yaml` + `evaluateGate` match on the event's `role` field (not `actor`),
   and the gate's `satisfiedBy` exposes `{ actor, role, recordedBy? }`.
5. The `check-plan-approved.sh` / plan-doc `Status:` read is removed from `gate()`
   and replaced with a clearly-labeled comment marking it a transitional concern
   (retained only in the prose `/rad-deliver` Step 2, the Decision 2 endpoint). All
   harness tests pass (`node --test`), updated to the new `actor`/`role` split, plus
   a new test proving the gate passes purely with no `sh` injected.

## Agent Scope
No role-restricted agents were called. Role is architect; the Agent Scope Map in
CLAUDE.md is an unpopulated placeholder, so no agent boundaries apply. Research was
one Explore sub-agent over `harness/` (gates.js, gates.yaml, git-state-store.js,
events.js, transitions.js, scripts/check-role.sh, and the four harness test files).

## Files in Scope
<!-- Lines must be a range or a single number. The linter sums these. -->
| File | Lines | Change |
|------|-------|--------|
| harness/events.js | 16-134 | Add `role` to the Event typedef; `reduce()` carries `role` on collected approvals |
| harness/adapters/git-state-store.js | 274-390 | `recordApproval`: take `actor`=identity, run `check-role.sh` at write-time, freeze `role`, refuse on failure. `gate()`: strip both read-time shell-outs → pure fold; label the doc-Status retirement |
| harness/gates.js | 62-118 | `actorHasRole`/`evaluateGate` match on the event's `role` field; `satisfiedBy` exposes `{actor, role, recordedBy?}` |
| harness/gates.yaml | 1-21 | The `approved` rule's condition reads `role` (keep declarative) |
| harness/transitions.js | 90-104 | Add a guard: an `approved` event without a `role` is an illegal transition |
| harness/test/events.test.js | 1-96 | Update `approved` event factories/assertions to the `actor`=identity + `role` split; assert `reduce` exposes `role` |
| harness/test/git-state-store.test.js | 25-147 | Update `recordApproval` tests (write-time role freeze + refusal); replace the gate mock-`sh` assertions with pure-fold assertions |
| harness/test/gates.test.js | 1-64 | Update gate tests to the `role`-field rule; keep the proxy (`recordedBy`) preservation case |
| harness/test/transitions.test.js | 1-92 | Add `role` to `approved` factories; add the missing-`role` rejection case |

## Execution Notes

### Do Not Touch
- `harness/spine.js`, `harness/matrix.js` — port boundaries; they call `state.gate()`
  / `state.append()` and must keep working unchanged.
- `scripts/check-plan-approved.sh`, `scripts/check-role.sh` — called, never modified.
  `check-plan-approved.sh` is now a transitional compat shim — mark, do not remove.
- The `rad/harness-cli-approve` branch and any `harness/cli.js` — out of scope; the
  CLI rebases on top of this change in its own cycle.

### Key Files
- `harness/adapters/git-state-store.js` — `gate()` at 274-316 (two shell-outs to
  remove) and `recordApproval()` at 375-390 (where write-time verification lands).
  Note `createGitStateStore` already injects `sh` and `evaluateGate` (used by tests).
- `harness/gates.js` — `actorHasRole` (62-65), `evaluateGate` (76-118), `satisfiedBy`
  construction (103-109). Stays a pure evaluator; only the matched field changes.
- `scripts/check-role.sh` — invocation is `check-role.sh <required-role> [claude-md]
  [identity-override]`; exit 0 = holds the role. `recordApproval` reproduces the
  call pattern `gate()` uses today (`[requiredRole, claudeMdPath, identity]`).
- `harness/test/git-state-store.test.js` — the hermetic gate test (102-128) injects
  mock `sh` + `evaluateGate` and asserts both scripts are CALLED; after the change
  the gate must NOT call `sh`, so those assertions invert (assert `sh` un-called).

### Reminders
- **Proxy parity:** in proxy mode the role frozen into `role` must be that of the
  `--on-behalf-of` architect (the `actor`), NOT the physical runner (`recordedBy`).
  Write-time `check-role.sh` runs against the `actor` identity.
- **Don't lose doc-Status authority:** removing `check-plan-approved.sh` from
  `gate()` is safe ONLY because the prose `/rad-deliver` Step 2 already calls it
  independently. State that explicitly in the code comment; do not also remove it
  from the prose command.
- **One canonical writer:** `recordApproval` is the only constructor of `approved`
  events; the `validateTransition` guard (AC#2) is the backstop for direct `append`.
- Run `node --test` in `harness/` after each wave — the event-shape change ripples
  through four test files; a green full suite is the regression guard.

## Wave Plan

### Wave 1 — sequential
Tasks must run in sequence: write-time freezing (1.2) depends on the new event
shape (1.1).

#### Task 1.1: Event shape — identity `actor` + verified `role`
File: harness/events.js:16-134, harness/test/events.test.js:1-96, harness/test/transitions.test.js:1-92
What: Add a `role` field to the Event typedef (the verified role token on an
`approved` event; `actor` is documented as the human identity). Update `reduce()`
so collected approvals carry `role` alongside `actor`/`recordedBy`. Update the
`approved` event factories and assertions in events.test.js (and add `role` to the
`approved` factories in transitions.test.js so the suite still constructs valid
events).
Validate: AC#1 — events.test.js asserts an `approved` event exposes `actor`
(identity) + `role`, and `reduce` surfaces `role`; full `node --test` green.

#### Task 1.2: Write-time role freeze + transition guard
File: harness/adapters/git-state-store.js:375-390, harness/transitions.js:90-104, harness/test/git-state-store.test.js:25-147, harness/test/transitions.test.js:1-92
What: In `recordApproval`, take `actor` as the human identity, run `check-role.sh
<requiredRole> <claudeMd> <actor>` via the injected `sh` once, refuse (throw, write
nothing) on non-zero exit, and freeze the verified role into the event's `role`
(proxy: verify the `--on-behalf-of` actor, not `recordedBy`). In `transitions.js`,
add a rule that an `approved` event lacking `role` is an illegal transition. Update
the `recordApproval` tests (success stamps `role`; failure refuses) and add the
missing-`role` rejection test.
Validate: AC#2 — recordApproval freezes `role` and refuses on a failed role check;
`validateTransition` rejects a role-less `approved` event; `node --test` green.

### Wave 2 — sequential
Depends on: Wave 1 complete (the `approved` event now carries `role`).

#### Task 2.1: Pure-fold gate rule reads `role`
File: harness/gates.js:62-118, harness/gates.yaml:1-21, harness/test/gates.test.js:1-64
What: Change `actorHasRole`/`evaluateGate` to match on the event's `role` field
instead of comparing `actor` to `requiredRole`; expose `{ actor, role, recordedBy? }`
in `satisfiedBy`. Update the `approved` rule in gates.yaml to read `role` (keep it
declarative). Update gates.test.js to the new shape, keeping the proxy-preservation
case.
Validate: AC#4 — evaluateGate passes for `role == architect` and fails otherwise,
purely from the event; `satisfiedBy` exposes `role`; gates.test.js green.

#### Task 2.2: Strip read-time shell-outs from `gate()`
File: harness/adapters/git-state-store.js:274-316, harness/test/git-state-store.test.js:102-147
What: Remove the `check-plan-approved.sh` and `check-role.sh` calls from `gate()`
so it returns the pure `evaluateGate` fold for `approved`. Replace the removed
doc-Status block with a clearly-labeled comment: the doc-Status authority is
transitional and now lives only in the prose `/rad-deliver` Step 2 (Decision 2
endpoint). Invert the hermetic gate test: assert `gate('approved')` resolves
`passed:true` from history alone with NO `sh` injected/called; add a `passed:false`
case for a role-less/wrong-role event.
Validate: AC#3 + AC#5 — `gate('approved')` performs no shell-out and decides from
history; the new no-`sh` pure-fold test passes; full `node --test` green.

## Tests to Write
- [ ] `approved` event factory/assertions for the `actor`=identity + `role` split; `reduce` exposes `role` — harness/test/events.test.js
- [ ] `recordApproval` freezes verified `role` at write-time; refuses on a failed `check-role.sh` — harness/test/git-state-store.test.js
- [ ] `validateTransition` rejects an `approved` event lacking `role` — harness/test/transitions.test.js
- [ ] `evaluateGate` + gates.yaml decide on `role`; `satisfiedBy` exposes `{actor, role, recordedBy?}` — harness/test/gates.test.js
- [ ] `gate('approved')` pure fold: passes from history with NO `sh` injected; fails for role-less/wrong-role — harness/test/git-state-store.test.js

## Non-Goals
- Not removing the plan-doc `Status:` dual-write from the CLI or `/rad-approve` —
  the doc stays a projection for now; the single-source cutover is Decision 2's
  destination, a later cycle.
- Not modifying the CLI on `rad/harness-cli-approve` — it rebases on top of this
  change afterward (its `actor='architect'` becomes `actor=identity, role='architect'`).
- Not deleting `check-plan-approved.sh` — it remains the transitional doc-Status
  shim used by prose `/rad-deliver`.
- Not changing `spine.js`, `matrix.js`, or the StateStore public method signatures.

## Out-of-Scope Dependencies
None — architect role, no role-restricted agents, all code is in the self-contained
`harness/` module.

## Risks
- **Event-shape ripple.** The `actor`/`role` split touches four test files; a missed
  assertion would fail the suite. Mitigated by running full `node --test` after each
  wave and treating green as the gate.
- **Deliver enforcement.** Dropping `check-plan-approved.sh` from `gate()` removes a
  doc-Status check from the spine path. Safe only because prose `/rad-deliver` Step 2
  calls it independently — verified in research; called out in the code comment and
  Reminders. If a future headless deliver bypasses the prose, it must re-add an
  explicit status gate.
- **Cross-branch staleness.** After this lands, the halted CLI on
  `rad/harness-cli-approve` records a now-stale `actor='architect'`; its rebase must
  update the `recordApproval` call to pass identity + let the store freeze `role`.
  Flagged for that cycle, not this one.
- **Proxy correctness.** Freezing the wrong identity's role (runner vs. on-behalf-of
  architect) would corrupt the audit trail; AC#2 + the Reminders pin the verified
  identity to `actor`.
