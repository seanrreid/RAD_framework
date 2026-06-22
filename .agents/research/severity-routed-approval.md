# Research: Severity-Routed Approval
Created: 2026-06-22
Author: architect
Status: pending-design
Source: GitHub issue #37 (https://github.com/seanrreid/RAD_framework/issues/37)

## Project Summary
A deterministic, fail-closed "severity router" layered on RAD's existing approval gate.
Plans whose entire declared scope is provably low-risk — v1: style/asset/doc-only, matched
by a new `RAD_LOW_RISK_PATTERNS` allowlist — auto-clear with a *recorded* policy-approval
event; every other plan still escalates to the architect. The point is to invoke the human
only when a change needs architectural/taste judgment, keeping the single architect from
becoming a bottleneck without ever removing the human. Correctness remains owned by the
deterministic checks on every path, cleared or not. This cycle includes the three-layer
audit so the architect can always see what the gate waved through.

## Key Requirements
- `RAD_LOW_RISK_PATTERNS` — extended-regex alternation, mirroring `RAD_HIGH_RISK_PATTERNS`.
  Empty/unset = OFF (today's behavior; opt-in, byte-for-byte backward-compatible).
- Granularity = plan-approval time; reuse the plan's declared Files-in-Scope and
  `scripts/check-scope.sh` for the touched-path set.
- Auto-clear iff: *every* touched path matches the allowlist AND *no* path matches the
  high-risk denylist AND scope did not expand beyond Files-in-Scope. High-risk wins ties.
- Default allowlist deliberately tight: `css|scss`, image/font assets, `\.md|^docs/`.
  Tests, config, lockfiles, CI are EXCLUDED from the default (a test edit can weaken the
  safety net — a judgment call).
- Globs-only classifier (no structural/AST signals in v1). Fail-closed: any code file is
  never on the allowlist, so it always gates; the classifier can only over-gate.
- On auto-clear, append a policy-approval `approved` event with provenance
  (`actor: severity-gate`, `recordedBy: policy`, matched patterns + file list) so
  `rad gate <feature> approved` passes identically to a human approval. Never a bypass —
  the gate stays a pure event-fold.
- Audit (in scope this cycle): (1) provenance on the event; (2) `/rad-insights`
  auto-cleared section (count / patterns / trend); (3) `kickoff` skill surfaces "N plans
  auto-cleared since last session."

## Domains

| Domain | Description | Sensitivity |
|--------|-------------|-------------|
| Gate / approval authority | Auto-clear decision + recorded policy-approval event; keeps the event-fold contract (`harness/gates.js`, event writer) | architect-only |
| Severity classifier scripts | Allowlist/denylist regex matching + scope-intersection over Files-in-Scope (`scripts/check-scope.sh`, `scripts/lint-plan.sh`) | architect-only |
| Config surface | `RAD_LOW_RISK_PATTERNS` documentation + defaults (CLAUDE.md RAD Configuration, `.env.example`) | architect-only |
| Observability / audit | `/rad-insights` auto-cleared section + `kickoff` session-start surfacing | open |

## Team

architect: sean@torchcodelab.com
developers: unassigned
designers: none

## Platform

platform: github
default_branch: main

## Constraints
- Deterministic only — no LLM severity classifier (the declined LLM auto-approval, renamed).
- Fail-closed — ambiguity always escalates to the architect.
- Must preserve the gate's pure event-fold nature (`harness/gates.js`); auto-clear is an
  event variant with provenance, not a special-case bypass branch.
- Opt-in and backward-compatible — unset `RAD_LOW_RISK_PATTERNS` reproduces today's
  behavior byte-for-byte (same pattern as `RAD_TOKEN_BUDGET`, `RAD_WORKTREE`, hooks).
- High-risk denylist (`RAD_HIGH_RISK_PATTERNS`) always wins precedence over the allowlist.

## Open Questions
- Event schema: exact field names/shape for the policy-approval provenance (align with the
  existing `recordedBy` proxy field and `recordApproval` write-time role freezing).
- Where the auto-clear decision physically fires in the flow — at `/rad-approve` time vs.
  at `/rad-deliver` gate-check time — given there is no plan PR (decide in design).
- Default allowlist exact regex set and how operators extend vs. replace it (mirror the
  `RAD_HIGH_RISK_PATTERNS` override semantics).
- `kickoff`/`rad-insights` read path for counting auto-cleared plans across features
  (event-log scan scope).

## Non-Goals (carried from #37)
- No LLM classifier; no role-based clearing; no structural detectors (v2); no quorum /
  tiered authority (multi-architect already mechanically supported — parked).
