# Research: Insights Feedback Loop
Created: 2026-07-03
Author: architect
Status: pending-design
Source: .agents/research/agent-reliability-stack-review.md (items 1 + 4, bundled) +
session ruling (2026-07-03): separable waves; all domains developer-open with an
events.js read/write-separation constraint.

## Project Summary
A read-side feedback-loop extension to `/rad-insights`, in two separable parts.
**Part A (reliability metrics):** fold over `.agents/state/*/events.jsonl` across all
features to surface system-level reliability metrics — wave success rate by outcome,
retry frequency, token spend per wave, and `fail-scope` vs `fail-tests` failure
distribution. **Part B (findings loop):** detect when a finding category in
`findings.jsonl` recurs N times and suggest the corresponding CLAUDE.md convention
line or lint rule. Both turn logs RAD already records into the feedback loop the
Agent Reliability Stack review identified as the framework's cheapest missing piece.

## Key Requirements
- **Pure read-side.** No new event types, no writes to `events.jsonl` — the audit
  trail stays append-only and untouched. The gate fold (`harness/gates.js`) is not
  modified.
- **Cross-feature aggregation.** Part A folds over every feature under
  `.agents/state/`, not a single feature's log.
- **Metrics grounded in what is already recorded:** the frozen 7-outcome matrix
  outcomes, retries, `wave-failed` reasons (incl. `token-budget`), token usage, hook
  vetoes (`hook-failed` and veto outcomes), and re-approvals.
- **Token-spend handling matches the budget-breaker convention:** waves whose adapter
  reports no usage contribute 0.
- **Part B output is a suggestion, never an auto-edit.** A human applies any
  CLAUDE.md/lint change via normal PR review; the tool only proposes.
- **Backward-compatible.** With empty or missing logs, `/rad-insights` behaves as
  today; no new required config.
- **Separable waves.** Parts A and B are planned as independent waves so Part B can
  be deferred or dropped if it balloons, without blocking Part A.

## Domains

| Domain | Description | Sensitivity |
|--------|-------------|-------------|
| Event-log read/aggregation | Cross-feature fold over `events.jsonl` for wave/outcome/retry/token metrics; read helpers only | open |
| Findings-recurrence loop | Recurrence detection over `findings.jsonl` + CLAUDE.md/lint suggestion output | open |
| Insights skill surface | `/rad-insights` report layout for both parts; optional `/wrap` touchpoint for Part B | open |

Sensitivity rationale: all three are read-only over existing logs and cannot touch
approval authority or the gate fold, and the existing audit-surface agents are already
developer-open. The one real risk — `harness/events.js` sharing a module with the
provenance-freezing writer — is handled by the read/write-separation constraint below
rather than by widening the architect-only boundary.

## Team

architect: sean@torchcodelab.com
developers: unassigned
designers: none

## Platform

platform: github
default_branch: main

## Constraints
- **events.js read/write separation.** Event-read work must either add read functions
  to `harness/events.js` without modifying existing writer/fold code, or extract read
  helpers into a separate read-only module. Which of the two is a `/rad-design`
  decision; the invariant (no writer/fold diff from this feature) is not.
- Reuse existing event-read helpers rather than reparsing JSONL ad hoc — the
  audit-surface mapper's anchors (rad-insights skill, kickoff skill, events.js read
  side) are the starting surface.
- Metrics are advisory display only — nothing in this feature gates, blocks, or
  auto-clears anything.

## Open Questions
- Recurrence threshold N for Part B: fixed default vs configurable (e.g.
  `RAD_FINDINGS_THRESHOLD`, following the existing optional-env-knob convention).
- Does Part B surface in `/rad-insights` only, or also in `/wrap`? (Spec allows
  either; suggest deciding in design.)
- Domain sensitivity was set developer-open by recommendation while the architect was
  away — confirm or flip at `/rad-design`.
