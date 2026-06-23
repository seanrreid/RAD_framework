# Architecture: Portable / Semi-Centralized Process Memory
Created: 2026-06-23
Status: approved
Research: .agents/research/portable-process-memory.md

## Agent Hierarchy

```
portable-memory-parent-orchestrator            roles: architect
├── sync-transport-orchestrator                 roles: architect
│   └── sync-surface-mapper                       reads: harness verb call sites (approve/deliver), git push/fetch invocation pattern, platform/mirror layer, .env.example → transport-seam + auth-inheritance map
└── event-fold-orchestrator                     roles: architect
    └── event-fold-mapper                          reads: harness/gates.js fold, events writer/schema, branch-tip read sites → ownership-event + divergence-refusal map
```

Two domains, each with a single read-only context tool. The split mirrors the two
genuinely separable concerns on the determinism boundary: **how state moves**
(push-on-write / fetch-on-read folded into the verbs, riding plain git on the user's
existing credentials, offline-fail-safe) vs **how the event log gains ownership and
refuses to fold when diverged** (new `owner-claimed`/`owner-released` event types + the
fail-closed divergence tripwire inside the gate fold). Both are architect-only — both sit
directly on the gate-fold / approval-authority boundary. Auth and divergence are
deliberately folded into these two rather than spun out (see Notes), keeping the hierarchy
lean and matched to the actual code seams (the verb layer vs `harness/gates.js` + the
events writer).

## Agent Definitions

### portable-memory-parent-orchestrator
- Type: parent-orchestrator
- Roles: architect
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates only
- Returns: a consolidated plan-ready summary delegating to the two domain orchestrators (sync-transport, event-fold), with the transport↔fold seam called out (transport performs the fetch; the fold decides whether to refuse on divergence); no file contents in main context
- Description: "Top orchestrator for the portable-process-memory feature. Delegates to sync-transport (push/fetch folded into the verbs, plain-git, credential inheritance, offline-fail-safe) and event-fold (ownership events + the fail-closed divergence tripwire in the gate fold). Architect-only; coordinates portability/transport work on the determinism boundary."

### sync-transport-orchestrator
- Type: role-orchestrator
- Roles: architect
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates to sync-surface-mapper
- Returns: where push-on-write and fetch-tip-on-read attach inside the state-mutating verbs (`rad approve`, `rad deliver`, ownership changes); the invariant that transport is **plain git only** (`git push`/`git fetch`) and never the host API — host CLIs (`gh`/`glab`) stay in the existing mirror/display layer and never enter the gate path; that auth is **inherited** from the user's existing git credentials (RAD never prompts for or stores them), leaving only error-messaging when git auth/remote is unavailable; and the offline stance (**local-durable always, push best-effort, no block, no loss**); ≤40 lines
- Description: "Owns how state moves between machines. Delegate here for anything touching the push/fetch wiring inside rad approve/deliver, the plain-git-not-host-API transport invariant, git-credential inheritance, offline-fail-safe behavior, or the RAD_* opt-in/config surface for sync. Architect-only."

### sync-surface-mapper
- Type: context-tool
- Roles: architect
- Model: claude-haiku-4-5-20251001
- Tools: Read, Grep, Glob
- Reads: the `/rad-approve` and `/rad-deliver` command/skill flow + their gate-check invocation sites, any existing `git`-invocation helper in `harness/`/`scripts/`, `scripts/detect-platform.sh` and the per-platform mirror scripts (`rad-label.sh` etc.), and the `### RAD Configuration` block in `CLAUDE.md` + `.env.example`
- Returns: the exact verb call sites where a push/fetch would attach (file:line); how RAD currently shells to git vs to `gh`/`glab` so transport can ride the former and avoid the latter; the existing `RAD_*` env-var doc pattern to mirror for any new sync knob; where the mirror/display layer lives so it stays out of the gate path; ≤35 lines, no raw file dumps
- Description: "MUST BE USED by sync-transport-orchestrator when mapping the verb call sites, the git-vs-host-CLI invocation boundary, the platform mirror layer, or the env-var config convention. Returns transport seam anchors and the auth-inheritance surface — never raw file contents."

### event-fold-orchestrator
- Type: role-orchestrator
- Roles: architect
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates to event-fold-mapper
- Returns: the `owner-claimed`/`owner-released` event schema (provenance aligned with the existing write-time role/`recordedBy` freezing) and how the fold treats them as a branch-level lock; how stale locks release (timeout vs explicit vs force-claim — flagged for plan decision); and the **fail-closed divergence tripwire** — on a diverged tip a *write* verb refuses to fold the gate and surfaces the conflicting holder ("X also has this open since HH:MM"), while a *read-only* verb may still display (decide in plan); the invariant that ownership/divergence are **event-fold additions, not a gate bypass** (`evaluateGate` stays a pure fold); ≤40 lines
- Description: "Owns how the event log gains ownership and refuses to fold when diverged. Delegate here for anything touching harness/gates.js, the events writer/schema, owner-claimed/owner-released events, branch-as-lock semantics, or the fail-closed divergence tripwire. Architect-only."

### event-fold-mapper
- Type: context-tool
- Roles: architect
- Model: claude-haiku-4-5-20251001
- Tools: Read, Grep, Glob
- Reads: `harness/gates.js` (the `evaluateGate` fold), `harness/events.js` (the writer + `recordApproval` write-time freezing), the event schema/`gates.yaml`, and the branch-tip read sites used by the gate-check (`rad gate <feature>` / `scripts/check-plan-approved.sh`)
- Returns: the current event shape and how `evaluateGate` folds it (file:line); how the writer freezes provenance (`role`/`recordedBy`) so new ownership events follow the same pattern; where the tip is read so a fetch-and-compare divergence check can attach; the load-bearing invariant that the fold has no special-case branches; ≤35 lines, no raw file dumps
- Description: "MUST BE USED by event-fold-orchestrator when mapping the gate event-fold, the events writer/provenance freezing, the event schema, or the branch-tip read sites. Returns file:line anchors and event-shape notes — never raw file contents."

## Scope Map

| Agent | Type | Reads | Roles |
|-------|------|-------|-------|
| portable-memory-parent-orchestrator | parent-orchestrator | nothing | architect |
| sync-transport-orchestrator | role-orchestrator | nothing | architect |
| sync-surface-mapper | context-tool | rad-approve/deliver verb sites, git-vs-host-CLI invocation, detect-platform.sh + mirror scripts, CLAUDE.md RAD config, .env.example | architect |
| event-fold-orchestrator | role-orchestrator | nothing | architect |
| event-fold-mapper | context-tool | harness/gates.js, events.js, gates.yaml, branch-tip read sites | architect |

## Notes

- **Two domains, not four.** The research artifact lists four in-scope domains (sync
  transport, ownership, divergence, auth). This architecture folds them into **two
  orchestrators along the actual code seams**: everything that *moves state through the
  verbs* (transport + auth-inheritance + offline) → `sync-transport`; everything that
  *changes how the event log folds* (ownership events + divergence-refusal) → `event-fold`.
  Auth collapses into transport because it's "ride the existing git credential" plumbing,
  not its own surface. Ownership and divergence collapse together because both live in
  `harness/gates.js` + the events writer and share one mapper surface. If you'd rather keep
  divergence or auth as their own orchestrators, say so in the approve step and I'll split.
- **The transport↔fold seam is the load-bearing coordination point.** Divergence has two
  halves: the *fetch-and-compare* (transport does the fetch) and the *decision to refuse
  folding* (the fold owns the refusal). The parent orchestrator coordinates this seam; the
  plan must keep the fetch in transport and the refusal in the fold, so `evaluateGate`
  stays a pure fold with no network in it.
- **Invariant: additions, not a bypass.** New `owner-claimed`/`owner-released` events and
  the divergence refusal must NOT introduce special-case branches into `evaluateGate` — it
  stays a pure fold over the frozen events. This mirrors the severity-routed-approval
  invariant (auto-clear was an event variant, not a gate bypass) and is the load-bearing
  correctness property here too.
- **Transport rides plain git, never the host API** — this is what makes the feature
  platform-agnostic *by construction*. `sync-surface-mapper` is scoped to surface the
  git-vs-`gh`/`glab` invocation boundary precisely so the design can attach to the former
  and leave the latter (the mirror/display layer) untouched.
- **No new authority.** Every agent here is a read-only context tool or a pure delegator —
  none writes files. Sync is transport; ownership is a lock; divergence is a tripwire.
  None of it adds a runtime approval. The only approval in the loop remains the pre-existing
  plan gate (`/rad-approve`), unchanged. Domain sensitivity is architect-only by the
  determinism-boundary principle (touches the fold ⇒ architect-only) and governs *who
  authors this code*, not who runs sync.
- **Open calls deferred to the plan (from research):** stale-lock release policy
  (timeout/explicit/force-claim); whether read-only verbs may proceed on a diverged tip;
  the exact v1 verb set that becomes sync-first; offline error-messaging UX.
- **Out of v1 scope:** the soft user-following recall store and Elastic-style procedural
  counters — no agent here covers it; it gets its own research/architecture when picked up.
