# Plan: Insights Feedback Loop
Created: 2026-07-03
Author: architect
Status: complete
Completed-At: 2026-07-03T17:10:00Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-07-03T16:37:09.149Z
Recorded-By: sean@torchcodelab.com
Branch: rad/insights-feedback-loop

## Context
`/rad-insights` today aggregates findings.jsonl (category/priority/reviewer
frequency) and already folds `.agents/state/*/events.jsonl` for token cost — but
none of the reliability signal RAD records (wave outcomes, retries, failure
reasons, hook vetoes) is surfaced anywhere, and recurring finding categories never
feed back into conventions. This plan adds Part A (a cross-feature Reliability
section backed by new pure read helpers in `harness/events.js`) and Part B (a
findings-recurrence section that *suggests* CLAUDE.md convention lines or lint
rules, plus an optional `/wrap` touchpoint). Pure read-side throughout.

## Scope
| In scope | Out of scope |
|---|---|
| New exported read helpers appended to harness/events.js (outcome/reason/retry/hook-veto folds), following the totalUsage precedent | ANY edit to events.js writer/fold code — reduce, phaseOf, PHASE_BY_TYPE, PHASE_ORDER stay byte-identical |
| Unit tests for the new helpers in harness/test/events.test.js | harness/spine.js, gates.js/gates.yaml, transitions.js, git-state-store.js — untouched |
| /rad-insights skill: new Reliability step (Part A) + Findings Recurrence step (Part B) | Writing to findings.jsonl or any events.jsonl; new event types |
| RAD_FINDINGS_THRESHOLD env knob documented in .env.example (default 5) | Modifying scripts/lint-plan.sh (Part B only *suggests* lint rules — lint scripts are architect surface) |
| /wrap session summary: optional recurrence note line | Auto-editing CLAUDE.md Coding Conventions (suggestion only, human applies) |

## Acceptance Criteria
1. `harness/events.js` exports new pure read helpers — `outcomeCounts(history)`, `failReasonCounts(history)`, `retryCounts(history)`, `hookVetoCounts(history)` — that guard non-array input and missing `data.*` fields, returning zeroed shapes (never throwing) on empty or wave-event-free histories; `reduce`, `phaseOf`, `PHASE_BY_TYPE`, `PHASE_ORDER` and all writer/fold code are byte-identical to before.
2. `node --test` in `harness/` passes, including new unit tests covering each helper's counting behavior (from synthetic wave-attempt/wave-complete/wave-failed/hook-veto histories matching the spine's recorded shapes) and the empty/missing-data tolerance contract.
3. `/rad-insights` gains a "Reliability" step that folds every `.agents/state/*/events.jsonl` cross-feature and reports: wave success rate by the frozen 7-outcome vocabulary (referenced from matrix.yaml/hook-runner — never re-listed by hand), retry frequency, wave-failed reason distribution (incl. `token-budget`), hook-veto count, and token spend per wave; with zero wave events in the logs it renders a zeros/"no wave data yet" section without error.
4. `/rad-insights` gains a "Findings Recurrence" step: any findings.jsonl category with count ≥ threshold yields a suggestion block containing a ready-to-paste CLAUDE.md Coding Conventions line or a described lint rule — output text only, with an explicit "suggestion — apply via PR" framing.
5. Threshold resolves as `RAD_FINDINGS_THRESHOLD` (positive integer) when set, else default 5; documented in `.env.example` as a new optional block in the existing `── … (optional) ──` style.
6. `/wrap`'s session summary includes a "Recurring findings" line only when at least one category meets the threshold, and omits it otherwise; `/wrap` writes nothing new beyond its existing plan-doc note.
7. The skills' Rules blocks still declare read-only behavior; the diff contains no writes to `.agents/findings.jsonl`, any `events.jsonl`, CLAUDE.md conventions, or lint scripts.

## Agent Scope
Research via Explore sub-agent within the developer-open insights-feedback-loop
surfaces (event-metrics-mapper and findings-surface-mapper Reads columns:
events.js read side, spine record-site shapes, matrix.yaml vocab, events.jsonl
and findings.jsonl samples, rad-insights + wrap skills, CLAUDE.md conventions,
lint-plan.sh as a read-only suggestion target). No out-of-scope dependencies:
the events.js work appends read functions only, which the approved architecture
explicitly permits without crossing into the architect-scoped writer/fold.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/events.js | 216-320 | Append 4 exported pure read helpers after totalUsage (same tolerance contract); zero edits above line 216 |
| harness/test/events.test.js | +90 | Unit tests: per-helper counting from synthetic spine-shaped histories; empty-history and missing-data.* tolerance; writer/fold untouched assertion via existing tests passing |
| .claude/commands/shared/rad-insights.md | 122-215 | Insert "Reliability" step after the token-cost step (same events.jsonl fold idiom, node one-liner over the new helpers) and "Findings Recurrence" step after the category-frequency step; extend report template + Rules stay read-only |
| .claude/skills/wrap/SKILL.md | 92-121 | Optional "Recurring findings" line in the session-summary template, threshold-gated, with a one-line step to compute it |
| .env.example | +8 | New "── Findings loop (optional) ──" block documenting RAD_FINDINGS_THRESHOLD (default 5) |

## Execution Notes

### Do Not Touch
- harness/events.js lines 1-215 (event model, PHASE_BY_TYPE, PHASE_ORDER, phaseOf, reduce, resumeFrom) — append-only below totalUsage
- harness/spine.js — all writer/record sites; read its shapes, never edit
- harness/gates.js, harness/gates.yaml, harness/transitions.js, harness/adapters/git-state-store.js — gate/writer authority
- .agents/findings.jsonl, .agents/state/*/events.jsonl — read-only data
- scripts/lint-plan.sh — Part B suggests lint rules in prose; the script is architect surface
- CLAUDE.md — suggestions target it but nothing in this plan edits it

### Key Files
- harness/events.js (totalUsage, lines 216-236) — the tolerance contract and style every new helper must follow
- harness/spine.js record sites (wave-attempt 309-332 with data.{wave,outcome,usage}; wave-failed with data.{wave,reason}; wave-complete with data.{wave,outcome}; hook-veto events) — the authoritative event shapes for tests and folds
- harness/matrix.yaml (lines 9-10, 29-35) + harness/hook-runner.js (VALID outcomes array, ~42-47) — the frozen 7-outcome vocabulary source; reference, never re-list
- .claude/commands/shared/rad-insights.md Step 4b (token cost, lines 82-121) — the existing cross-feature events.jsonl fold idiom to mirror
- .agents/findings.jsonl — category is the grouping key (current counts: testing 14, code-clarity 12, security 9, error-handling 7, correctness 5, ...)
- cli.js RAD_TOKEN_BUDGET parse (~448-450) — the env-knob read pattern for the threshold

### Reminders
- Committed event logs currently contain ONLY `approved` events — no wave events exist yet. Every fold must return zeroed shapes on wave-event-free logs (AC#3); tests must cover this explicitly.
- Part A/Part B separability: Tasks 2.1 (Part A skill) and 2.2/3.1 (Part B) share no files with each other; dropping Part B orphans nothing.
- Skill edits are prose + one-liners: keep the rad-insights idiom (fold per feature dir, jq/node one-liners); the node one-liner should import the events.js helpers rather than re-implementing counting in jq, so the helpers stay the single source of truth.
- CI now runs on every PR (harness tests, events append-only, agent-file lint, deliver-integrity) — the deliver PR for this branch is gated by check-approval-integrity.sh; do not edit the plan after approval without re-approving.
- RAD_FINDINGS_THRESHOLD: parse with Number.parseInt, treat unset/0/NaN/negative as "use default 5" (mirror RAD_TOKEN_BUDGET semantics: invalid disables nothing here, it just falls back).

## Wave Plan

### Wave 1 — sequential
Foundation: the read helpers everything in Part A builds on.

#### Task 1.1: events.js read helpers + unit tests
File: harness/events.js:216-320
What: Append four exported pure read functions after `totalUsage`, each with the same JSDoc + tolerance style: `outcomeCounts(history)` → map of the frozen 7 outcomes to counts from wave-complete events (plus total); `failReasonCounts(history)` → map of wave-failed data.reason values to counts; `retryCounts(history)` → per-wave wave-attempt counts and a retried-waves total (attempts beyond the first per wave number); `hookVetoCounts(history)` → count of hook-veto events (and wave-attempt events whose data carries a hook source). Guard `Array.isArray`, tolerate absent data/fields, return zeroed shapes. Zero edits above line 216. Add unit tests in harness/test/events.test.js: synthetic histories shaped per the spine record sites validating each count; empty-array, non-array, and approved-only histories return zeros; existing suite still green (`npm test --prefix harness`).
Validate: AC#1, AC#2 — `node --test` passes with new tests; `git diff harness/events.js` shows only appended lines below totalUsage.

### Wave 2 — parallel
Depends on: Wave 1 complete (Task 2.1 imports the helpers; Task 2.2 is independent Part B).

#### Task 2.1: rad-insights Reliability section (Part A)
File: .claude/commands/shared/rad-insights.md:122-215
What: Insert a new step after the token-cost step: fold every .agents/state/*/events.jsonl via a node one-liner importing the new events.js helpers (outcomeCounts, failReasonCounts, retryCounts, hookVetoCounts, totalUsage per wave), and extend the report template with a "Reliability" section showing success rate by outcome, retry frequency, failure-reason distribution, hook vetoes, and token spend per wave — with an explicit "no wave data yet" rendering when counts are all zero. Renumber/cross-reference surrounding steps as needed; Rules block stays read-only.
Validate: AC#3 — run the documented one-liner against the real repo (currently wave-event-free) and confirm the zeros path renders; run it against a synthetic temp log with wave events and confirm non-zero counts appear.

#### Task 2.2: rad-insights Findings Recurrence section + env knob (Part B)
File: .claude/commands/shared/rad-insights.md:50-68; .env.example:+8
What: Insert a "Findings Recurrence" step after the category-frequency step: compute per-category counts (reuse the step's existing count), resolve threshold from RAD_FINDINGS_THRESHOLD (default 5, RAD_TOKEN_BUDGET-style parse), and for each category at/above threshold emit a suggestion block — a ready-to-paste `## Coding Conventions` line or a described lint rule — explicitly framed "suggestion — apply via PR; never auto-applied". Extend the report template accordingly. Add the "── Findings loop (optional) ──" block to .env.example documenting RAD_FINDINGS_THRESHOLD.
Validate: AC#4, AC#5 — against the real findings.jsonl (5 categories ≥5) the documented computation lists exactly those categories with suggestion blocks; with RAD_FINDINGS_THRESHOLD=100 it lists none.

### Wave 3 — sequential (Part B tail, droppable)
Depends on: Wave 2 complete.

#### Task 3.1: wrap recurrence touchpoint
File: .claude/skills/wrap/SKILL.md:92-121
What: Add a threshold-gated "Recurring findings: [categories] — run /rad-insights for suggested conventions" line to the session-summary template (after "Concerns flagged"), with a one-line computation step reusing the same category-count + RAD_FINDINGS_THRESHOLD resolution as rad-insights; when no category meets the threshold the line is omitted entirely. No new writes.
Validate: AC#6 — the documented computation against the real findings.jsonl yields the line; with RAD_FINDINGS_THRESHOLD=100 the template omits it.

## Tests to Write
- [ ] outcomeCounts/failReasonCounts/retryCounts/hookVetoCounts count correctly from synthetic spine-shaped histories — harness/test/events.test.js
- [ ] all four helpers return zeroed shapes on empty, non-array, and approved-only histories (tolerance contract) — harness/test/events.test.js

## Non-Goals
- No new CLI subcommand — the skill layer uses node one-liners over the exported helpers, matching the existing insights idiom.
- No auto-application of suggestions — CLAUDE.md and lint scripts are never edited by anything in this feature.
- No new event types and no writes to any log — the audit trail is a read-only input.
- No dashboard/persistence — the metrics render in the /rad-insights report only.

## Out-of-Scope Dependencies
None. The events.js additions are append-only read functions, which the approved
architecture explicitly carves out from the architect-scoped writer/fold surface.

## Risks
- events.js is shared with the writer/fold: the append-only constraint is the
  control; validation includes a diff check that nothing above the append point
  changed (and CI's harness tests cover the fold's behavior regardless).
- The wave-event folds are validated mostly against synthetic histories (real
  committed logs have no wave events yet) — shapes are taken from spine.js record
  sites, but a shape drift there would surface only when real deliver runs record
  usage; the tolerance contract bounds the blast radius to zeros, never a crash.
- rad-insights.md is prose consumed by a model: renumbering steps or breaking the
  existing jq one-liners would degrade other sections; validation re-runs the
  existing documented one-liners after the edit.
