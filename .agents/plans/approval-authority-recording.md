# Plan: Approval-Authority Recording
Created: 2026-06-23
Author: architect
Status: complete
Completed-At: 2026-06-23T19:40:00Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-06-23T19:18:42.711Z
Recorded-By: sean@torchcodelab.com
Branch: rad/approval-authority-recording

## Context
RAD records architect approval two ways. Plan approval (`/rad-approve`) appends a frozen
`approved` event (gate authority); design approval (`/rad-design`) is a soft `Status:`
flip with no event. And once a plan is approved, editing it can't be re-attested — the
`transitions.js` duplicate-`approved` block stops re-recording, so the frozen event keeps
passing the gate against changed content ([[rad-no-reapproval-path]]). This plan adds
**(A)** a frozen, audit-only `architecture-approved` event on `/rad-design` approval
(recorded to a reserved project-level log, no enforcement gate), and **(B)** a
**plan-content fingerprint** stamped into the `approved` event so the gate-read **fails
closed** when the plan is edited after approval — both keeping `evaluateGate` a pure fold.

## Scope
| In scope | Out of scope |
|---|---|
| `architecture-approved` audit event + reserved `_architecture` log | Any enforcement gate for design approval (audit-only) |
| Plan-content fingerprint stamped at `/rad-approve`, compared fail-closed at the gate-read boundary | Putting the fingerprint compare *inside* `evaluateGate` (it stays a pure fold) |
| Relaxing duplicate-`approved` to admit a fingerprint-differing re-approval | A `revoke` event / withdraw-without-edit (declined as primary mechanism) |
| Mirroring `recordApproval`/`recordPolicyApproval` writer + proxy provenance | Severity-routing `/rad-design` (declined); matrix/spine/wave-hooks |

## Acceptance Criteria
<!-- Numbered, testable outcomes. Every Wave task's Validate: field must cite one. -->
1. On `/rad-design` inline approval, a frozen `architecture-approved` event is appended to
   `.agents/state/_architecture/events.jsonl` — role frozen at write-time (mirroring
   `recordApproval`), proxy provenance (`recordedBy`), `data.slug` naming the project. It is
   **audit-only**: no gate folds it; `evaluateGate` is unchanged.
2. The reserved `_architecture` key is admitted past `isSafeFeature` by an **explicit
   exception** (fail-closed: the base `^[a-z0-9][a-z0-9-]*$` rule is otherwise unchanged, so
   `_architecture` cannot collide with a real feature slug).
3. `/rad-approve` stamps a fingerprint of the plan's **normative region** (excluding the
   mutable header — `Status`/`Approved-*`/`Completed-*`/`Re-reviewed:` lines) into the
   `approved` event's `data.fingerprint`, via a single shared `plan-fingerprint` utility.
4. The gate-read (`check-plan-approved.sh`) recomputes the current plan's fingerprint and
   **fails closed** ("plan modified after approval") when it differs from the latest
   `approved` event's stored fingerprint; it passes when equal. `evaluateGate` is untouched
   (the compare lives at the boundary).
5. Re-running `/rad-approve` after an edit appends a **fresh** `approved` event with the new
   fingerprint (duplicate-`approved` relaxed to admit a fingerprint-**differing**
   re-approval); an identical-fingerprint re-approval is still blocked.

## Agent Scope
Research delegated to a single Explore sub-agent (architect role). Domains map to the
architect-only `approval-event-model-orchestrator`/`approval-event-mapper` (event model)
and `approval-command-integration-orchestrator`/`approval-command-mapper` (verb wiring). No
out-of-scope dependencies.

## Files in Scope
<!-- Lines must be a range or a single number. Linter sums these for context budget. -->
| File | Lines | Change |
|------|-------|--------|
| harness/plan-fingerprint.js | 1-70 | NEW shared util: `planFingerprint(planText)` → SHA-256 over the normative region (strip the mutable header lines; hash Scope, Acceptance Criteria, Files-in-Scope, Wave Plan, Execution Notes). Mirror the crypto pattern in `harness/fingerprint.js:41-51` |
| harness/events.js | 16-33, 80-96 | Add `architecture-approved` to the Event typedef and to `PHASE_BY_TYPE` as a **no-phase** audit event (precedent: `owner-claimed`/`owner-released`); the `approved` event gains an optional `data.fingerprint` |
| harness/transitions.js | 94-114 | Relax duplicate-`approved` (94-103) to admit a second `approved` whose `data.fingerprint` differs (block when identical); admit `architecture-approved` under the same role-freeze validation as `approved` (105-114) |
| harness/adapters/git-state-store.js | 78-80, 98-100, 362-432 | `isSafeFeature` explicit `_architecture` exception; `recordArchitectureApproved` writer (mirror `recordApproval` role-freeze via `check-role.sh`; event `feature:'_architecture'`, frozen role, `recordedBy`, `data:{slug,evidence?}`); `recordApproval` accepts + stamps `data.fingerprint` |
| harness/cli.js | 33-56, 810-855 | `approveCommand` computes `planFingerprint` and passes it to `recordApproval` (810-855); add read-only `plan-fingerprint <planFile>` subcommand (prints the hash) and `architecture-approve <slug>` subcommand invoking `recordArchitectureApproved` (33-56 dispatch) |
| scripts/check-plan-approved.sh | 47-90 | After `resolve_events`, compute the current plan's hash via `node harness/cli.js plan-fingerprint`, extract the latest `approved` event's stored fingerprint, **fail closed** on mismatch; pass through when equal — before piping to `rad gate` |
| .claude/commands/architect/rad-design.md | 152-162 | Step 4 inline-approve: after the `Status` flip, call `node harness/cli.js architecture-approve <slug>` (proxy-aware) to write the audit event; `Status` documented as a display mirror |
| .claude/commands/architect/rad-approve.md | 237-254 | Note that approval stamps a plan fingerprint (and re-running re-attests an edited plan); keep the proxy (`--on-behalf-of`/`recordedBy`) behavior |
| harness/test/approval-authority-recording.test.js | 1-1 | NEW test file covering AC#1–5 |
| .agents/research/approval-authority-recording.md | 1-1 | Research artifact (`/rad-research` output) shipping with the feature |
| .agents/architecture/approval-authority-recording.md | 1-1 | Architecture artifact (`/rad-design` output) shipping with the feature |
| .claude/agents/approval-authority-parent-orchestrator.md | 1-1 | Generated agent definition for this feature |
| .claude/agents/approval-event-model-orchestrator.md | 1-1 | Generated agent definition for this feature |
| .claude/agents/approval-event-mapper.md | 1-1 | Generated agent definition for this feature |
| .claude/agents/approval-command-integration-orchestrator.md | 1-1 | Generated agent definition for this feature |
| .claude/agents/approval-command-mapper.md | 1-1 | Generated agent definition for this feature |
| CLAUDE.md | 348-358 | Agent Scope Map rows for this feature's 5 agents |

## Execution Notes

### Do Not Touch
- harness/gates.js — `evaluateGate` stays a pure fold; the fingerprint compare lives at the boundary (AC#4), never in the fold.
- harness/gates.yaml — the `approved` rule is unchanged; `architecture-approved` is audit-only and gets **no** gate rule.
- harness/spine.js, harness/matrix.js, harness/matrix.yaml, harness/hook-runner.js — orthogonal; do not couple approval-authority logic into them.
- harness/fingerprint.js — reuse its crypto *pattern* in the new `plan-fingerprint.js`; do not modify the doom-loop fingerprinter.

### Key Files
- harness/adapters/git-state-store.js — `recordApproval` (362-390) + `recordPolicyApproval` (414-432) are the writer shapes to mirror; `eventsPath` (98-100) + `isSafeFeature` (78-80) gate the log path.
- harness/fingerprint.js — the SHA-256 normalize→stringify→digest pattern to reuse.
- harness/test/policy-approval.test.js — the event-shape + write-path test conventions to mirror.

### Reminders
- `architecture-approved` is **audit-only** — never add it to `gates.yaml` or fold it in `evaluateGate`.
- One shared fingerprint source of truth: `plan-fingerprint.js` is computed by the CLI and consumed by `check-plan-approved.sh` (via the `plan-fingerprint` subcommand) — do not reimplement the hash in bash.
- The fingerprint must exclude the mutable header (else it is circular — approval/deliver rewrite those lines). Hash a stable normative region only.
- Preserve the `approved-missing-role` transition (105-114) and apply role-freeze to `architecture-approved` too.
- `_architecture` admission is an **explicit exception**, not a loosened regex — keep `isSafeFeature` fail-closed for everything else.

## Wave Plan

### Wave 1 — parallel
Tasks touch distinct files.

#### Task 1.1: Plan-fingerprint utility
File: harness/plan-fingerprint.js:1-70
What: NEW ESM module exporting `planFingerprint(planText)` → `{ hash }` (SHA-256 hex). Strip the mutable header lines (`Status`/`Approved-*`/`Completed-*`/`Re-reviewed:`), then hash a canonical concatenation of the Scope, Acceptance Criteria, Files-in-Scope, Wave Plan, and Execution Notes sections. Reuse the `createHash('sha256')` normalize→stringify→digest pattern from `harness/fingerprint.js:41-51`. Deterministic; whitespace-normalized.
Validate: AC#3 — the same plan text yields a stable hash; editing a normative section changes it; editing only the header does NOT.

#### Task 1.2: `architecture-approved` event type
File: harness/events.js:16-33, 80-96
What: Add `architecture-approved` to the Event typedef and to `PHASE_BY_TYPE` as a **no-phase** audit event (mirror `owner-claimed`/`owner-released`). Document `data.fingerprint` as an optional field on `approved`.
Validate: AC#1 — `architecture-approved` is a recognized data-only event; the fold/phases are unaffected.

### Wave 2 — sequential
Depends on: Wave 1 (the event type + util exist)

#### Task 2.1: Transition rules
File: harness/transitions.js:94-114
What: Relax the duplicate-`approved` rule (94-103) to admit a second `approved` when its `data.fingerprint` differs from the prior one (block when identical — a true duplicate). Admit `architecture-approved` under the same role-freeze validation as `approved` (preserve `approved-missing-role`, 105-114).
Validate: AC#5 — a fingerprint-differing re-approval is allowed; an identical-fingerprint one is blocked.

#### Task 2.2: Store writers + reserved key
File: harness/adapters/git-state-store.js:78-80, 98-100, 362-432
What: (a) `isSafeFeature` explicit `_architecture` exception (fail-closed otherwise). (b) `recordArchitectureApproved({slug,...})` mirroring `recordApproval` (role frozen via `check-role.sh`; event `feature:'_architecture'`, `type:'architecture-approved'`, `recordedBy`, `data:{slug,evidence?}`). (c) `recordApproval` accepts a `fingerprint` and stamps it into the `approved` event's `data.fingerprint`.
Validate: AC#1, AC#2, AC#3 — the writer appends a frozen audit event to `_architecture`; the reserved key is admitted; `approved` carries the fingerprint.

### Wave 3 — sequential
Depends on: Wave 2 (writers exist)

#### Task 3.1: CLI wiring
File: harness/cli.js:33-56, 810-855
What: `approveCommand` reads the plan, computes `planFingerprint`, and passes it to `recordApproval` (810-855). Add a read-only `plan-fingerprint <planFile>` subcommand (prints the hash) and an `architecture-approve <slug>` subcommand (proxy-aware) calling `recordArchitectureApproved` (33-56 dispatch).
Validate: AC#3, AC#1 — approve stamps the fingerprint; `plan-fingerprint` prints a stable hash; `architecture-approve` writes the audit event.

#### Task 3.2: Gate-read fingerprint compare (boundary)
File: scripts/check-plan-approved.sh:47-90
What: After `resolve_events`, compute the current plan's hash via `node harness/cli.js plan-fingerprint <planFile>`, extract the latest `approved` event's `data.fingerprint` from the resolved JSONL, and **fail closed** (exit non-zero, "plan modified after approval") on mismatch; pass through when equal — before piping to `rad gate`. `evaluateGate` untouched.
Validate: AC#4 — an edited-after-approval plan fails the gate-read; an unedited one passes; the fold is unchanged.

#### Task 3.3: Command prose
File: .claude/commands/architect/rad-design.md:152-162
What: In the Step 4 inline-approve flow, after the `Status: draft → approved` flip, invoke `node harness/cli.js architecture-approve <slug>` (carrying `--on-behalf-of`/`--evidence` when in proxy mode) to write the audit event; note `Status` is now a display mirror of that event.
Validate: AC#1 — `/rad-design` approval records the `architecture-approved` event (not just the Status flip).

### Wave 4 — sequential
Depends on: Wave 3

#### Task 4.1: Test coverage
File: harness/test/approval-authority-recording.test.js:1-1
What: NEW `node:test` suite mirroring `policy-approval.test.js`: (1) `recordArchitectureApproved` appends a frozen `_architecture` audit event with proxy provenance, and `evaluateGate` is unaffected (AC#1); (2) `isSafeFeature` admits `_architecture` but still rejects other leading-underscore/invalid keys (AC#2); (3) `planFingerprint` is stable, header-insensitive, normative-sensitive (AC#3); (4) the gate-read fails closed on an edited plan, passes when unedited (AC#4); (5) a fingerprint-differing re-approval is admitted, identical is blocked (AC#5).
Validate: AC#1, AC#2, AC#3, AC#4, AC#5 — each has a passing test.

## Tests to Write
- [ ] `recordArchitectureApproved` writes a frozen `_architecture` audit event; gate unaffected — harness/test/approval-authority-recording.test.js
- [ ] `isSafeFeature` admits `_architecture`, rejects other invalid keys — harness/test/approval-authority-recording.test.js
- [ ] `planFingerprint` stable / header-insensitive / normative-sensitive — harness/test/approval-authority-recording.test.js
- [ ] Gate-read fails closed on edit-after-approval, passes when unedited — harness/test/approval-authority-recording.test.js
- [ ] Fingerprint-differing re-approval admitted; identical blocked — harness/test/approval-authority-recording.test.js

## Non-Goals
- No enforcement gate for design approval — `architecture-approved` is audit-only; the human + PR remain the enforcement.
- No `revoke`/withdraw-without-edit verb (declined as the primary mechanism; fingerprint is automatic fail-closed).
- No fingerprint compare inside `evaluateGate` — it stays a pure fold; the compare is at the gate-read boundary.
- No change to the plan-approval gate's autonomous-deliver enforcement; re-approval only adds re-attestation.
- No severity-routing of `/rad-design`.

## Out-of-Scope Dependencies
None — all surfaces are within the architect-only approval-authority scope.

## Risks
- **Fold purity / circular hash:** the compare must stay at the boundary, and the hash must exclude the mutable header. Mitigation: `gates.js` in Do Not Touch (AC#4); the util strips header lines (AC#3 test).
- **Reserved-key collision:** a loosened `isSafeFeature` could admit unintended keys. Mitigation: explicit `_architecture` exception, base rule unchanged (AC#2 test rejects other underscore keys).
- **Re-approval over-permit:** relaxing duplicate-`approved` could admit a true duplicate. Mitigation: admit only when `data.fingerprint` differs; identical still blocked (AC#5 test).
- **Backward-compat for old approvals:** an `approved` event with no `data.fingerprint` (pre-feature) must not hard-fail the gate. Mitigation: the boundary treats a missing stored fingerprint as "legacy — pass" (compare only when a fingerprint is present); note in Task 3.2.
