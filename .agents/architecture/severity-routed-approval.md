# Architecture: Severity-Routed Approval
Created: 2026-06-22
Status: approved
Research: .agents/research/severity-routed-approval.md

## Agent Hierarchy

```
severity-approval-parent-orchestrator          roles: architect
├── gate-authority-orchestrator                 roles: architect
│   └── gate-authority-mapper                    reads: harness/gates.js, gates.yaml, events.js, /rad-approve + /rad-deliver gate-check sites → decision-point + event-schema map
├── severity-classifier-orchestrator            roles: architect
│   └── classifier-surface-mapper                reads: scripts/check-scope.sh, lint-plan.sh, CLAUDE.md RAD config, .env.example → pattern-match + scope-intersection map
└── audit-surface-orchestrator                  roles: developer
    └── audit-surface-mapper                      reads: rad-insights skill, kickoff skill, event-log read path → surfacing-point map
```

Three domains, each with a single read-only context tool. The split mirrors the
three genuinely separable concerns: **how authority is recorded and where the
decision fires** (the gate event-fold + decision point) vs **how severity is
computed** (allowlist/denylist/scope-intersection + the config surface) vs **how
the architect sees what was waved through** (the audit surfacing). The first two
are architect-only — they touch approval authority on the determinism boundary.
The audit surface is presentational and read-only over the event log, so it is
`developer`-open per the research artifact. The config surface (`RAD_LOW_RISK_PATTERNS`
doc + `.env.example`) folds into the classifier domain, which consumes it.

## Agent Definitions

### severity-approval-parent-orchestrator
- Type: parent-orchestrator
- Roles: architect
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates only
- Returns: a consolidated plan-ready summary delegating to the three domain orchestrators; no file contents in main context
- Description: "Top orchestrator for the severity-routed-approval feature. Delegates to gate-authority (how auto-clear is recorded + where the decision fires), severity-classifier (how low-risk is computed + config), and audit-surface (how auto-clears are surfaced). Architect-only; coordinates approval-authority work on the determinism boundary."

### gate-authority-orchestrator
- Type: role-orchestrator
- Roles: architect
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates to gate-authority-mapper
- Returns: how the auto-clear write attaches **inside `/rad-approve`** (DECIDED — see Notes; the approve verb auto-appends the policy-approval event when scope is provably low-risk, keeping the deliver gate-check read-only), the exact policy-approval event schema (provenance fields aligned with the existing `recordedBy` proxy + `recordApproval` write-time role freezing), and the invariant that auto-clear is an **event variant, not a gate bypass** (the fold in `harness/gates.js` stays untouched); ≤40 lines
- Description: "Owns how a policy-approval is recorded and where the auto-clear decision fires. Delegate here for anything touching harness/gates.js, gates.yaml, the events writer, recordApproval, or the /rad-approve and /rad-deliver gate-check call sites. Architect-only."

### gate-authority-mapper
- Type: context-tool
- Roles: architect
- Model: claude-haiku-4-5-20251001
- Tools: Read, Grep, Glob
- Reads: `harness/gates.js`, `harness/gates.yaml`, `harness/events.js`, `recordApproval` (event writer), and the gate-check invocation sites in the `/rad-approve` and `/rad-deliver` command/skill flow + `scripts/check-plan-approved.sh`
- Returns: the `approved`-event shape and how `evaluateGate` folds it (file:line); how `recordApproval` freezes `role` and where `recordedBy`/proxy provenance attaches; the candidate decision-fire points (approve-time vs deliver-gate-time) each with anchor; ≤35 lines, no raw file dumps
- Description: "MUST BE USED by gate-authority-orchestrator when mapping the approval event schema, the gate event-fold, recordApproval provenance, or the approve/deliver gate-check sites. Returns file:line anchors and event-shape notes — never raw file contents."

### severity-classifier-orchestrator
- Type: role-orchestrator
- Roles: architect
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates to classifier-surface-mapper
- Returns: the auto-clear predicate (every touched path matches `RAD_LOW_RISK_PATTERNS` AND none matches `RAD_HIGH_RISK_PATTERNS` AND scope unchanged; **high-risk wins ties; fail-closed**), how to reuse the Files-in-Scope + `check-scope.sh` touched-path set, the default tight allowlist regex set, and the `RAD_LOW_RISK_PATTERNS` override semantics (mirror `RAD_HIGH_RISK_PATTERNS`: empty = OFF); ≤40 lines
- Description: "Owns how low-risk is computed and the config surface. Delegate here for anything touching scripts/check-scope.sh, lint-plan.sh, the allowlist/denylist regex matching, RAD_LOW_RISK_PATTERNS, or its CLAUDE.md / .env.example documentation. Architect-only."

### classifier-surface-mapper
- Type: context-tool
- Roles: architect
- Model: claude-haiku-4-5-20251001
- Tools: Read, Grep, Glob
- Reads: `scripts/check-scope.sh`, `scripts/lint-plan.sh`, the `RAD_HIGH_RISK_PATTERNS` handling, the `### RAD Configuration` / Plan-Lint block in `CLAUDE.md`, and `.env.example`
- Returns: how `lint-plan.sh` currently matches `RAD_HIGH_RISK_PATTERNS` over the Files-in-Scope ∪ per-task paths (file:line); how `check-scope.sh` computes the touched-path set; the existing env-var doc pattern to mirror for `RAD_LOW_RISK_PATTERNS`; ≤35 lines, no raw file dumps
- Description: "MUST BE USED by severity-classifier-orchestrator when mapping the existing risk-pattern matching, scope computation, or env-var documentation pattern. Returns the match logic, scope-set source, and config-doc convention — never raw file contents."

### audit-surface-orchestrator
- Type: role-orchestrator
- Roles: developer
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates to audit-surface-mapper
- Returns: where the three audit layers attach — the `/rad-insights` auto-cleared section (count / patterns / trend), the `kickoff` "N auto-cleared since last session" line, and the event-log read path that counts policy-approval events across features; the read-only invariant (audit never writes authority, only surfaces it); ≤35 lines
- Description: "Owns surfacing what the gate auto-cleared. Delegate here for anything touching the /rad-insights skill, the kickoff skill, or the event-log read path that counts policy-approval events. Developer-open; read-only over the event log."

### audit-surface-mapper
- Type: context-tool
- Roles: developer
- Model: claude-haiku-4-5-20251001
- Tools: Read, Grep, Glob
- Reads: the `rad-insights` skill (`.agents/findings.jsonl` reader), the `kickoff` skill, and the event-log read helpers in `harness/events.js` (the fold/read side)
- Returns: where `/rad-insights` aggregates today (section pattern to extend); where `kickoff` reports plan status at session start (the line to add near); the event-read helper that can count `approved` events with policy provenance; ≤35 lines, no raw file dumps
- Description: "MUST BE USED by audit-surface-orchestrator when mapping the rad-insights aggregation, the kickoff session-start report, or the event-read helpers. Returns the extension points and read helpers — never raw file contents."

## Scope Map

| Agent | Type | Reads | Roles |
|-------|------|-------|-------|
| severity-approval-parent-orchestrator | parent-orchestrator | nothing | architect |
| gate-authority-orchestrator | role-orchestrator | nothing | architect |
| gate-authority-mapper | context-tool | harness/gates.js, gates.yaml, events.js, approve/deliver gate-check sites | architect |
| severity-classifier-orchestrator | role-orchestrator | nothing | architect |
| classifier-surface-mapper | context-tool | scripts/check-scope.sh, lint-plan.sh, CLAUDE.md RAD config, .env.example | architect |
| audit-surface-orchestrator | role-orchestrator | nothing | developer |
| audit-surface-mapper | context-tool | rad-insights skill, kickoff skill, events.js read side | developer |

## Notes

- **The pivotal design call — where auto-clear fires. DECIDED (2026-06-22): inside
  `/rad-approve`.** Because RAD has no plan PR, "plan-approval time" is not a PR event.
  The two candidates were: (a) inside `/rad-approve`, appending the policy-approval event
  automatically when scope is provably low-risk; or (b) at `/rad-deliver`'s
  `rad gate <feature> approved` check, satisfying the gate by policy. **Chose (a)** — it
  keeps the gate-check read-only (the "gate is a pure fold" story stays intact: only the
  approve verb ever *writes* authority, the deliver gate only ever *reads* it). Consequence
  the plan must handle: `/rad-approve` (or a non-interactive equivalent) runs even for
  auto-cleared plans — something still "approves," it is just the policy doing it. The plan
  settles *how* the approve verb is invoked non-interactively for auto-clear, not *whether*
  the write lives there.
- **Invariant: event variant, not bypass.** Auto-clear MUST append a normal `approved`
  event whose frozen `role` is `architect`, distinguished only by provenance
  (`actor: severity-gate`, `recordedBy: policy`). `harness/gates.js` `evaluateGate` stays
  untouched — it already folds on the frozen `role`, so a policy-approval satisfies it for
  free. No special-case branch in the gate. This is the load-bearing correctness property.
- **Strong reuse prior.** `lint-plan.sh` already matches `RAD_HIGH_RISK_PATTERNS` over the
  Files-in-Scope ∪ per-task paths; `check-scope.sh` already computes touched paths. The
  classifier should generalize/reuse these rather than introduce a parallel matcher.
  `classifier-surface-mapper` is scoped to surface both so the design extends them.
- **Fail-closed is the safety net, not the classifier.** Globs-only means any code file is
  never on the allowlist → always gates. The classifier can only over-gate. Correctness on
  auto-cleared paths is still owned by the deterministic checks (`check-tests`,
  `check-scope`) that run regardless. The plan must NOT let auto-clear skip those checks.
- **Audit is the only open-roles domain** and the only one that writes no authority — it
  reads the event log and surfaces counts. Kept separate from gate-authority precisely
  because the role boundary differs (developer-open vs architect-only) even though both
  touch `harness/events.js` (writer side vs reader side).
- **Three domains vs the prior feature's two.** Justified: recording authority, computing
  severity, and surfacing audit have distinct read scopes AND distinct role boundaries.
  Collapsing audit into gate-authority would cross the architect-only/developer line.
- All agents are read-only context tools or pure delegators — none write files. Actual
  edits happen in deliver waves, bounded by these scopes.
- **Non-goals (carried from #37):** no LLM classifier; no role-based clearing; no
  structural detectors (v2); no quorum/tiered authority (parked).
