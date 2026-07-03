# Architecture: Insights Feedback Loop
Created: 2026-07-03
Status: approved
Research: .agents/research/insights-feedback-loop.md

## Agent Hierarchy

```
insights-feedback-parent-orchestrator          roles: developer
├── event-metrics-orchestrator                 roles: developer
│   └── event-metrics-mapper                   reads: events.js read side, spine outcome/usage record sites, events.jsonl schema, gates.yaml vocab
└── findings-loop-orchestrator                 roles: developer
    └── findings-surface-mapper                reads: findings.jsonl schema, rad-insights + wrap skills, CLAUDE.md conventions section
```

## Agent Definitions

### insights-feedback-parent-orchestrator
- Type: parent-orchestrator
- Roles: developer
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates only
- Returns: delegation summary — which sub-orchestrator handled what, decisions made, max 30 lines
- Description: "Top orchestrator for the insights-feedback-loop feature. Delegates to event-metrics (Part A: cross-feature events.jsonl reliability metrics) and findings-loop (Part B: findings-recurrence detection + CLAUDE.md/lint suggestions). Developer-open; coordinates the shared /rad-insights report surface across both parts. Pure read-side — never touches the events writer or gate fold."

### event-metrics-orchestrator
- Type: role-orchestrator
- Roles: developer
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates only
- Returns: decision summary — chosen read-helper seam, metric definitions, report-section shape, max 30 lines
- Description: "Owns Part A: cross-feature reliability metrics folded from .agents/state/*/events.jsonl (wave success by outcome, retries, token spend, failure-reason distribution). Delegate here for anything touching event-read helpers or the metrics section of /rad-insights. Hard constraint: read-side only — must not modify writer/fold code in harness/events.js or gates.js; extract a read module if needed. Developer-open."

### event-metrics-mapper
- Type: context-tool
- Roles: developer
- Model: claude-haiku-4-5-20251001
- Tools: Read, Grep, Glob
- Reads: harness/events.js (read-side helpers and event schema), harness/spine.js (outcome/retry/token-usage record sites), harness/gates.yaml (outcome vocabulary), .agents/state/*/events.jsonl (shape samples only)
- Returns: file:line anchors + event-shape notes (event types, fields carrying outcome/retry/usage data, existing read helpers vs gaps) — never raw file contents, max 40 lines
- Description: "MUST BE USED by event-metrics-orchestrator when mapping the event schema, existing read helpers, the writer/read seam in events.js, or where the spine records wave outcomes, retries, and token usage. Returns file:line anchors and event-shape notes — never raw file contents."

### findings-loop-orchestrator
- Type: role-orchestrator
- Roles: developer
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates only
- Returns: decision summary — recurrence rule (threshold + grouping key), suggestion output format, insights/wrap placement, max 30 lines
- Description: "Owns Part B: recurrence detection over .agents/findings.jsonl and the resulting CLAUDE.md-convention / lint-rule suggestions. Delegate here for anything touching the findings read path, the recurrence threshold (fixed vs RAD_FINDINGS_THRESHOLD), or the suggestion section of /rad-insights and the optional /wrap touchpoint. Suggestions only — never auto-edits CLAUDE.md or lint scripts. Developer-open."

### findings-surface-mapper
- Type: context-tool
- Roles: developer
- Model: claude-haiku-4-5-20251001
- Tools: Read, Grep, Glob
- Reads: .agents/findings.jsonl (shape samples only), the rad-insights and wrap skill files, CLAUDE.md Coding Conventions section, scripts/lint-plan.sh (suggestion-target conventions)
- Returns: file:line anchors + finding-category shape notes (category field, grouping candidates, existing insights report sections, wrap append point) — never raw file contents, max 40 lines
- Description: "MUST BE USED by findings-loop-orchestrator when mapping the findings.jsonl record shape, the existing /rad-insights aggregation sections, the /wrap progress-note append point, or the CLAUDE.md/lint conventions a suggestion would target. Returns file:line anchors and shape notes — never raw file contents."

## Scope Map

| Agent | Type | Reads | Roles |
|-------|------|-------|-------|
| insights-feedback-parent-orchestrator | parent-orchestrator | nothing | developer |
| event-metrics-orchestrator | role-orchestrator | nothing | developer |
| event-metrics-mapper | context-tool | harness/events.js read side, spine outcome/usage record sites, gates.yaml vocab, .agents/state/*/events.jsonl samples | developer |
| findings-loop-orchestrator | role-orchestrator | nothing | developer |
| findings-surface-mapper | context-tool | .agents/findings.jsonl samples, rad-insights + wrap skills, CLAUDE.md conventions, lint-plan.sh | developer |

## Notes

- **Parent orchestrator is developer, overriding the architect-only default.** Every
  prior feature's parent is architect-only, but those all touched the determinism
  boundary; this feature is pure read-side by requirement, and the research artifact
  marks all domains open. Flip the parent to architect at approval if you want the
  convention kept uniform — nothing else in the design changes.
- **Two orchestrators, not three.** The research's third domain (insights skill
  surface) is a shared display layer: each part owns its own report section, and the
  parent coordinates the shared layout. A third orchestrator would own no code of
  its own.
- **The read/write-separation constraint lives in the event-metrics-orchestrator
  description** ("must not modify writer/fold code; extract a read module if
  needed") so it binds at delegation time, not just in the plan. The
  add-functions-vs-extract-module choice is left to plan/deliver, per the research.
- **Separable waves preserved:** Part A and Part B share no agents below the parent,
  so a plan can wave them independently and drop Part B without orphaning anything.
- Open questions carried into planning: recurrence threshold (fixed vs
  RAD_FINDINGS_THRESHOLD), /wrap touchpoint yes/no.
