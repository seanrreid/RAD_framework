# Research: Approval-Authority Recording
Created: 2026-06-23
Author: architect
Status: pending-design
Source: GitHub issue #39 (https://github.com/seanrreid/RAD_framework/issues/39) +
session ruling (2026-06-23): audit-only event, bundle the re-approval gap
([[rad-no-reapproval-path]]).

## Project Summary
An approval-authority recording pass that brings how RAD records architect approval into
closer parity with its settled gate-authority model, across two bundled sub-problems that
share the `recordApproval` / event-model surface:

- **(A) Design-approval audit event.** Today `/rad-design` approval is a soft
  `Status: draft → approved` field flip — no event, no frozen role. This adds a frozen
  `architecture-approved` event recorded at approval time (consistency, queryable
  authority, proxy-compatible), with **no enforcement gate** — nothing autonomous reads
  it; the architect's inline review plus the git commit/PR that lands the agent files
  remain the enforcement. The decision recorded (#39): **audit-only, not full parity** —
  because plan approval is hard precisely to gate *unattended* deliver execution, a reason
  that does not transfer to a human-in-session, PR-reviewed design approval.
- **(B) Plan re-approval path.** Today editing a plan after `/rad-approve` cannot be
  re-attested: the transition model blocks a duplicate `approved`, so the frozen event
  keeps passing the gate against changed content (an integrity hole). This adds a way to
  re-attest an edited plan — closing [[rad-no-reapproval-path]].

The companion idea (severity-*routing* `/rad-design` to auto-skip approval) stays
**declined** — boundary design is never correctness-irrelevant. This work is purely about
*how* approval is recorded, never *whether* it happens.

## Key Requirements
- **(A) Frozen `architecture-approved` event.** Written when `/rad-design` approves inline;
  freezes the approver role once at write-time (mirror `recordApproval`); composes with
  proxy approval (`--on-behalf-of` / `recordedBy`). **Audit-only — no gate reads it for
  enforcement.** The `Status:` header becomes a display mirror of this event (as plan
  approval already is).
- **(A) Resolve the event-log location.** Plan/feature events live in
  `.agents/state/<feature>/events.jsonl`. Architecture is **project-level**, not
  feature-scoped — there is no existing log path. This is the load-bearing unknown and
  must be settled in design before anything is built.
- **(B) Re-approval mechanism.** Pick one (in design): a **revoke + re-approve** event
  pair, OR a **plan-content fingerprint** stamped on the `approved` event so the gate
  fail-closes (treats the plan as unapproved) once the plan's content diverges from the
  fingerprint. Either must keep the gate a **pure fold** and stay **fail-closed**.
- Both: keep `harness/gates.js` `evaluateGate` a pure fold; no network/side-effects in the
  fold; frozen-at-write-time provenance; opt-in/backward-compatible where the change could
  alter today's behavior.

## Domains

All three are **architect-only** by the determinism-boundary principle: anything touching
approval-authority recording or the gate fold is architect-only. This governs *who authors
the code*, not a runtime gate. Adopting teams may reassign; the principle is what
generalizes.

| Domain | Description | Sensitivity |
|--------|-------------|-------------|
| Approval event model & writer | New `architecture-approved` event type (audit, no gate) + re-approval handling in `recordApproval`, `harness/events.js`, `harness/transitions.js` (the duplicate-`approved` rule), and the `gates.js` fold (kept pure) | architect-only |
| Design-approval integration + event-log location | Where `/rad-design`'s inline approve writes the event; **resolving the project-level (non-feature-scoped) architecture event-log path** | architect-only |
| Plan re-approval flow | The chosen mechanism (revoke+re-approve vs plan-fingerprint) and its `/rad-approve` CLI surface; how the gate fail-closes on edit-after-approval | architect-only |

## Team

> Convention correct for *this* team; adopting teams adjust to their own roster.

architect: sean@torchcodelab.com
developers: unassigned
designers: none

## Platform

> GitHub here; keep the design **git-native / host-API-independent** (events are git-tracked
> JSONL, folded by the CLI) consistent with the project's platform-agnostic stance.

platform: github
default_branch: main

## Constraints
- **Audit-only for design approval** — no new enforcement gate; nothing autonomous consumes
  the `architecture-approved` event (the human + PR are the enforcement).
- Preserve the gate's pure event-fold (`harness/gates.js`); recording adds an event variant
  + (for re-approval) a transition/fingerprint rule, never a special-case branch in the fold.
- Frozen-role-at-write-time provenance, mirroring `recordApproval`; proxy-approval
  (`--on-behalf-of` / `recordedBy`) compatible.
- Fail-closed for the re-approval path: an edited-after-approval plan must be treated as
  **not** approved until re-attested — never silently pass.
- Backward-compatible where a change could alter today's behavior; the inline
  `/rad-design` approve/edit/cancel UX should not regress.
- Severity-routing of `/rad-design` remains declined (out of scope).

## Open Questions
- **Event-log location — DECIDED (2026-06-23): a reserved project-level log at
  `.agents/state/_architecture/events.jsonl`.** Keeps the per-feature
  `state/<feature>/events.jsonl` convention intact and adds one reserved project-scoped
  stream (the `_architecture` key is reserved — must not collide with a real feature slug;
  the existing `isSafeFeature` `^[a-z0-9]...` pattern already excludes a leading `_`, so the
  reserved name is structurally distinct). Rejected: per-artifact keying (architecture is
  one-per-project — awkward) and folding into an existing project stream (entangles design
  approval with unrelated events).
- **Re-approval mechanism — DECIDED (2026-06-23): plan-content fingerprint, fail-closed.**
  `/rad-approve` stamps a hash of the plan's **normative region** into the `approved` event;
  the **gate-read boundary** (`check-plan-approved.sh` / CLI wrapper) recomputes the current
  plan's hash and **fails closed on mismatch** — `evaluateGate` stays a pure fold (it folds
  to "an approval with fingerprint X exists"; the comparison lives at the boundary, the same
  fetch-at-boundary pattern as portable-process-memory and the #35 enforce-at-boundary
  pattern). Re-approval = re-run `/rad-approve`, stamping a fresh fingerprint event; the
  `transitions.js` duplicate-`approved` block is **relaxed to admit a fingerprint-differing
  re-approval** (append-only audit preserved: approve@hash1, approve@hash2). Rejected:
  revoke+re-approve as the *primary* mechanism — fail-OPEN unless the revoke reliably fires
  (the discipline-dependent weakness #35 eliminated). **Implementation subtlety to nail in
  the plan:** the canonical normative region to hash — exclude the mutable header
  (`Status`/`Approved-*`/`Completed-*`/`Re-reviewed:` lines that approval/deliver rewrite,
  else the hash is circular); hash a stable set (Scope, Acceptance Criteria, Files-in-Scope,
  Wave Plan, Execution Notes).
- **Sequencing within v1** — both sub-problems share `events.js`/`transitions.js`/
  `recordApproval`; decide in design whether they are one wave set or staged (design-audit-
  event is blocked on the event-log-location question; re-approval is more self-contained
  and could lead).
- **Interaction with the inline `/rad-design` approval (PR #38)** — the inline approve step
  is the natural place to *write* the `architecture-approved` event, replacing the bare
  `Status` flip; confirm it composes without changing that UX.
- **Proxy provenance shape** for `architecture-approved` (align with the existing
  `recordedBy` proxy field and `recordApproval` write-time role freezing).

## Non-Goals
- No enforcement gate for design approval (audit-only).
- No severity-routing / auto-skip of `/rad-design` approval (declined).
- No change to the plan-approval gate's autonomous-deliver enforcement (the hard gate
  stays); re-approval only adds re-attestation, it does not weaken the existing gate.
