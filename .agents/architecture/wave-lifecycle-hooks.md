# Architecture: Wave-Lifecycle Hooks for the Deliver Spine
Created: 2026-06-15
Status: approved
Research: .agents/research/wave-lifecycle-hooks.md

## Agent Hierarchy

```
hooks-parent-orchestrator                roles: architect
├── spine-integration-orchestrator       roles: architect
│   └── spine-mapper                      reads: harness/spine.js, matrix.js, matrix.yaml → insertion-point map
└── hook-runtime-orchestrator            roles: architect
    └── hook-surface-mapper               reads: harness/adapters/agent/contract.js, events writer, scripts/ → runtime+config map
```

Two domains, each with a single read-only context tool. The split mirrors the
two genuinely separable concerns: **where hooks fire** (spine control flow +
matrix interaction) vs **how hooks run and are registered** (the runner module,
event emission, config surface). Everything is architect-only — this is
whole-spine work on the determinism boundary (issue #13).

## Agent Definitions

### hooks-parent-orchestrator
- Type: parent-orchestrator
- Roles: architect
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates only
- Returns: a consolidated plan-ready summary delegating to the two domain orchestrators; no file contents in main context
- Description: "Top orchestrator for the wave-lifecycle-hooks feature. Delegates to spine-integration (where hooks fire) and hook-runtime (how hooks run + register). Architect-only; coordinates the determinism-boundary work."

### spine-integration-orchestrator
- Type: role-orchestrator
- Roles: architect
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates to spine-mapper
- Returns: the set of hook insertion points with file:line anchors, plus the **observe+veto** interaction with `resolveOutcome` and `matrix.yaml` (how a hook-emitted outcome re-enters the matrix, constrained to the fixed vocabulary); ≤40 lines
- Description: "Owns hook insertion into the deliver spine and its matrix interaction. Delegate here for anything touching harness/spine.js wave-loop control flow, resolveOutcome, or the stop-condition matrix. Architect-only."

### spine-mapper
- Type: context-tool
- Roles: architect
- Model: claude-haiku-4-5-20251001
- Tools: Read, Grep, Glob
- Reads: `harness/spine.js`, `harness/matrix.js`, `harness/matrix.yaml`
- Returns: a table of candidate hook points (`pre-wave`, `post-wave`, `on-outcome`, `on-retry`, `on-error`, `wave-complete`) each with file:line anchor and the surrounding function; flags where a veto outcome would re-enter `resolveOutcome`; ≤35 lines, no raw file dumps
- Description: "MUST BE USED by spine-integration-orchestrator when locating hook insertion points or matrix-interaction seams in the deliver spine. Returns file:line anchors and outcome-flow notes — never raw file contents."

### hook-runtime-orchestrator
- Type: role-orchestrator
- Roles: architect
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates to hook-surface-mapper
- Returns: the hook-runner contract (invocation: argv/env/stdin, exit-code semantics, ordering), the **veto failure semantics** (fail-open vs fail-closed per hook class; how a hook emits a fixed-vocabulary outcome), the config surface choice, and the event-emission integration; ≤40 lines
- Description: "Owns the hook runner module, the operator config surface (scripts/hooks dir vs env vs CLAUDE.md block), and event-log integration. Delegate here for how a hook is registered, invoked, and recorded. Architect-only."

### hook-surface-mapper
- Type: context-tool
- Roles: architect
- Model: claude-haiku-4-5-20251001
- Tools: Read, Grep, Glob
- Reads: `harness/adapters/agent/contract.js`, the `events.jsonl` writer module, `scripts/**` (esp. existing post-checks like `check-tests.sh`, `check-scope.sh`, `open-pr.sh`, `lint-plan.sh`)
- Returns: the existing event types + emit sites, the post-check invocation pattern to mirror, and where a hook-runner would slot in; flags duplication against the hard-coded `check-tests.sh` veto; ≤35 lines, no raw file dumps
- Description: "MUST BE USED by hook-runtime-orchestrator when mapping the event writer, existing post-check/guardrail scripts, or the config surface. Returns emit sites, the script-invocation pattern, and dedup notes — never raw file contents."

## Scope Map

| Agent | Type | Reads | Roles |
|-------|------|-------|-------|
| hooks-parent-orchestrator | parent-orchestrator | nothing | architect |
| spine-integration-orchestrator | role-orchestrator | nothing | architect |
| spine-mapper | context-tool | harness/spine.js, matrix.js, matrix.yaml | architect |
| hook-runtime-orchestrator | role-orchestrator | nothing | architect |
| hook-surface-mapper | context-tool | contract.js, events writer, scripts/** | architect |

## Notes

- **Hook power model: RESOLVED → observe+veto** (2026-06-15). Hooks may emit a
  matrix outcome from the **fixed vocabulary** (`fail-scope`, etc.) and reroute via
  `resolveOutcome`, acting as deterministic guardrails. This generalizes the
  hard-coded `check-tests.sh` per-wave veto rather than duplicating it. The plan
  must still settle the *veto failure semantics* (fail-open vs fail-closed per hook
  class) and ensure a veto outcome is distinguishable in `events.jsonl` from an
  agent-emitted one (provenance). A crashing **observe-class** hook must never fail
  a wave; failure handling of a crashing **veto-class** hook is a `/rad-plan` call.
- **Structure: two orchestrators (confirmed 2026-06-15).** Keeps "where hooks
  fire" (spine + matrix) separate from "how hooks run/register" (runner, events,
  config). The two read scopes stay distinct; collapse-to-one was considered and
  declined.
- **Strong dedup prior:** `check-tests.sh` is already a hard-coded per-wave veto.
  `hook-surface-mapper` is scoped to surface it so the design generalizes that
  pattern rather than duplicating it.
- **No new domains vs research.** The five research domains collapse cleanly into
  these two read scopes; the event writer and config surface both live under
  hook-runtime to avoid a third thin orchestrator.
- All agents are read-only context tools or pure delegators — none write files.
  Actual edits happen in deliver waves, bounded by these scopes.
