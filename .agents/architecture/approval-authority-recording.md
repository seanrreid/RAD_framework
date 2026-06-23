# Architecture: Approval-Authority Recording
Created: 2026-06-23
Status: approved
Research: .agents/research/approval-authority-recording.md

## Agent Hierarchy

```
approval-authority-parent-orchestrator          roles: architect
├── approval-event-model-orchestrator            roles: architect
│   └── approval-event-mapper                      reads: harness/events.js, transitions.js, gates.js, gates.yaml, adapters/git-state-store.js (recordApproval) → event-shape + transition + fold map
└── approval-command-integration-orchestrator    roles: architect
    └── approval-command-mapper                     reads: .claude/commands/architect/rad-design.md + rad-approve.md, harness/cli.js (approve/design handlers), check-plan-approved.sh → verb-write-site map
```

Two role-orchestrators split by **code layer**, not by sub-problem — because the two
sub-problems (design-audit-event + plan re-approval) both touch the same event model and
the same verb surfaces, a layer split avoids two orchestrators editing `events.js`/
`transitions.js` in parallel. **`approval-event-model`** owns *how authority is recorded as
events* (the new `architecture-approved` type, its frozen-provenance writer, the reserved
`_architecture` project-level log, and the re-approval transition/fingerprint rule — all
while keeping `evaluateGate` a pure fold). **`approval-command-integration`** owns *where
the verbs write that authority* (the `/rad-design` inline-approve write site replacing the
`Status` flip, and the `/rad-approve` re-approval verb). Both architect-only — both sit on
the approval-authority / determinism boundary. The research's three domains collapse here:
the event-log-location concern folds into event-model (it is where the store writes), and
the design-integration concern folds into command-integration (it is a verb write site).

## Agent Definitions

### approval-authority-parent-orchestrator
- Type: parent-orchestrator
- Roles: architect
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates only
- Returns: a consolidated plan-ready summary delegating to the two domain orchestrators (event-model, command-integration), with the model↔verb seam called out (the model defines the event/writer/log/transition; the verbs call it) and the two sub-problems (design-audit-event, re-approval) mapped across both; no file contents in main context
- Description: "Top orchestrator for the approval-authority-recording feature. Delegates to approval-event-model (the architecture-approved event type, the reserved _architecture project log, re-approval transition/fingerprint, pure-fold preservation) and approval-command-integration (the /rad-design inline-approve write site + the /rad-approve re-approval verb). Architect-only; coordinates approval-authority recording on the determinism boundary."

### approval-event-model-orchestrator
- Type: role-orchestrator
- Roles: architect
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates to approval-event-mapper
- Returns: the `architecture-approved` event schema (frozen role at write-time, mirroring `recordApproval`; **audit-only — no gate folds it for enforcement**); the reserved `_architecture` project-level event-log path (`.agents/state/_architecture/events.jsonl`) and how the writer/reader handles a reserved key the `isSafeFeature` pattern would otherwise reject; the re-approval mechanism recommendation (revoke+re-approve event **vs** a plan-content fingerprint on the `approved` event that makes the gate fail-closed on divergence) with the fail-closed invariant; and the load-bearing rule that all of this stays an **event/transition addition, never a special-case branch in `evaluateGate`**; ≤45 lines
- Description: "Owns how approval authority is recorded as events. Delegate here for anything touching harness/events.js, transitions.js, gates.js (fold), gates.yaml, recordApproval, the new architecture-approved event type, the reserved _architecture project log, or the re-approval transition/fingerprint rule. Architect-only."

### approval-event-mapper
- Type: context-tool
- Roles: architect
- Model: claude-haiku-4-5-20251001
- Tools: Read, Grep, Glob
- Reads: `harness/events.js` (Event typedef, PHASE_BY_TYPE, the reduce/fold), `harness/transitions.js` (the duplicate-`approved` block + validateTransition rules), `harness/gates.js` (`evaluateGate`), `harness/gates.yaml`, and `harness/adapters/git-state-store.js` (`recordApproval`/`recordPolicyApproval` write-time role freezing + the `state/<feature>/events.jsonl` path construction + `isSafeFeature`)
- Returns: the current `approved` event shape + how `evaluateGate` folds it (file:line); how `recordApproval` freezes `role`/`recordedBy` so `architecture-approved` mirrors it; the exact `transitions.js` rule that blocks a duplicate `approved` (the re-approval seam); how the event-log path is built from the feature slug + where `isSafeFeature` is enforced (so a reserved `_architecture` key can be admitted); ≤35 lines, no raw file dumps
- Description: "MUST BE USED by approval-event-model-orchestrator when mapping the event schema, the gate fold, the duplicate-approved transition rule, recordApproval provenance freezing, or the event-log path/isSafeFeature construction. Returns file:line anchors and event/transition-shape notes — never raw file contents."

### approval-command-integration-orchestrator
- Type: role-orchestrator
- Roles: architect
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates to approval-command-mapper
- Returns: where `/rad-design`'s inline approve step writes the `architecture-approved` event (replacing the bare `Status: draft → approved` flip; the `Status` header becomes a display mirror, as plan approval already is) without changing the approve/edit/cancel UX; where `/rad-approve` gains a re-approval path (the CLI verb + how it invokes the event-model's chosen mechanism) staying proxy-compatible (`--on-behalf-of`/`recordedBy`); the invariant that the commands only *write* authority via the event-model writer, never re-implement it; ≤40 lines
- Description: "Owns where the verbs write approval authority. Delegate here for anything touching the /rad-design inline-approve write site, the /rad-approve re-approval verb, or their harness/cli.js handlers. Architect-only."

### approval-command-mapper
- Type: context-tool
- Roles: architect
- Model: claude-haiku-4-5-20251001
- Tools: Read, Grep, Glob
- Reads: `.claude/commands/architect/rad-design.md` (the inline approve step), `.claude/commands/architect/rad-approve.md` (the approval flow + proxy handling), `harness/cli.js` (`approveCommand` and any design/approve handler), and `scripts/check-plan-approved.sh`
- Returns: the exact `/rad-design` inline-approve step where the `Status` flip happens today (the write site to replace, file:line); how `/rad-approve` records approval + handles `--on-behalf-of`/`recordedBy` (the pattern the re-approval verb mirrors); the `cli.js` `approveCommand` structure where a re-approval subcommand attaches; ≤35 lines, no raw file dumps
- Description: "MUST BE USED by approval-command-integration-orchestrator when mapping the /rad-design inline-approve write site, the /rad-approve flow + proxy handling, or the cli.js approve handler. Returns the verb write-site anchors — never raw file contents."

## Scope Map

| Agent | Type | Reads | Roles |
|-------|------|-------|-------|
| approval-authority-parent-orchestrator | parent-orchestrator | nothing | architect |
| approval-event-model-orchestrator | role-orchestrator | nothing | architect |
| approval-event-mapper | context-tool | harness/events.js, transitions.js, gates.js, gates.yaml, adapters/git-state-store.js (recordApproval) | architect |
| approval-command-integration-orchestrator | role-orchestrator | nothing | architect |
| approval-command-mapper | context-tool | .claude/commands/architect/rad-design.md + rad-approve.md, harness/cli.js, check-plan-approved.sh | architect |

## Notes

- **Two orchestrators, layer-split (not sub-problem-split).** The research lists three
  domains and two sub-problems (design-audit-event + re-approval). This collapses them to
  **event-model** (how authority is recorded) vs **command-integration** (where verbs write
  it), because both sub-problems touch `events.js`/`transitions.js` *and* a verb — a
  layer split keeps each shared file owned by one orchestrator. If you'd rather isolate the
  two sub-problems so they can ship independently, say so at approve and I'll re-split.
- **The pivotal design call is deferred to the plan, by design: the re-approval
  mechanism.** Revoke+re-approve event pair (simple, explicit, append-only) vs a
  plan-content fingerprint stamped on the `approved` event so the gate fail-closes when the
  plan diverges (stronger integrity, but adds a hash to the fold's input). `approval-event-
  model-orchestrator` is scoped to recommend one; both must keep `evaluateGate` a pure fold
  and stay fail-closed. Flag for explicit architect sign-off in the plan.
- **Invariant: event/transition addition, not a fold branch.** `architecture-approved`
  must NOT be folded by `evaluateGate` for enforcement (it is audit-only), and re-approval
  must be expressed as a transition/fingerprint rule, NOT a special-case branch in the
  fold. Mirrors the severity-routed-approval invariant (auto-clear was an event variant,
  not a gate bypass) and the portable-process-memory invariant (transport at the boundary,
  fold stays pure).
- **Reserved `_architecture` key is collision-safe by construction.** `isSafeFeature`
  (`^[a-z0-9][a-z0-9-]*$`) rejects a leading underscore, so `_architecture` cannot collide
  with a real feature slug — but the writer/reader must *admit* the reserved key past that
  same validation. `approval-event-mapper` is scoped to surface where `isSafeFeature` gates
  the path so the design threads the reserved key through cleanly.
- **No new authority for autonomous flows.** Design approval is audit-only (no gate reads
  it); the plan-approval gate's autonomous-deliver enforcement is unchanged. Re-approval
  only *re-attests* an edited plan — it never weakens the existing hard gate. Every agent
  here is a read-only mapper or a pure delegator; none writes files.
- **Carries forward [[rad-no-reapproval-path]]** (the gap that motivated sub-problem B) and
  the #39 ruling (audit-only, not full parity).
