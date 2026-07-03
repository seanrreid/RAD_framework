# Architecture: Harness CI
Created: 2026-07-03
Status: approved
Research: .agents/research/harness-ci.md

## Agent Hierarchy

```
harness-ci-parent-orchestrator                 roles: architect
├── ci-wiring-orchestrator                     roles: architect
│   └── ci-surface-mapper                      reads: script output/exit conventions, deliver-gate hook, platform scripts, harness test entry points
├── integrity-checks-orchestrator              roles: architect
│   └── integrity-surface-mapper               reads: gates.js fold, events.js schema, plan-fingerprint.js, recordApproval, git-sync.sh, events.jsonl samples
└── convention-lints-orchestrator              roles: architect
    └── lint-surface-mapper                    reads: lint-plan.sh, check-scope.sh, plan-paths.sh, .claude/agents/* samples, CLAUDE.md scope map
```

## Agent Definitions

### harness-ci-parent-orchestrator
- Type: parent-orchestrator
- Roles: architect
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates only
- Returns: delegation summary — which sub-orchestrator handled what, decisions made, max 30 lines
- Description: "Top orchestrator for the harness-ci feature. Delegates to ci-wiring (workflow YAML, triggers, deliver-PR detection, PR annotations), integrity-checks (approval ancestry/fingerprint/authenticity, append-only enforcement, ownership advisory), and convention-lints (agent-file lint, scope-map sync, scope-check + plan-lint CI wiring). Architect-only; coordinates the scripts-first invariant — every check is a standalone script callable locally and from CI, and workflow YAML is only a thin wrapper."

### ci-wiring-orchestrator
- Type: role-orchestrator
- Roles: architect
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates only
- Returns: decision summary — workflow/job layout, trigger rules, deliver-PR detection mechanism, annotation contract, max 30 lines
- Description: "Owns the CI wiring: .github/workflows/ job structure, triggers, the rad/-branch-with-plan deliver-PR detection (clean no-op on ordinary PRs), and the runner-neutral advisory/annotation output contract. Delegate here for anything touching workflow YAML, Layer-1 test jobs (harness node --test + scripts/test-*.sh), or how checks surface in the PR. Hard constraints: YAML is a thin wrapper — no check logic lives in workflow files; GitHub Actions is the default wrapper but every check stays invocable on any runner. Architect-only."

### ci-surface-mapper
- Type: context-tool
- Roles: architect
- Model: claude-haiku-4-5-20251001
- Tools: Read, Grep, Glob
- Reads: scripts/*.sh (output/exit-code conventions only), scripts/deliver-gate-hook.mjs, scripts/detect-platform.sh + get-default-branch.sh, harness/package.json test entry, scripts/test-*.sh invocation patterns
- Returns: file:line anchors + convention notes (exit-code vocabulary, stdout contracts, test entry points, platform-detection seams) — never raw file contents, max 40 lines
- Description: "MUST BE USED by ci-wiring-orchestrator when mapping existing script exit-code/output conventions, the harness and shell test entry points, the platform-detection seam, or the deliver-gate hook's invocation shape. Returns file:line anchors and convention notes — never raw file contents."

### integrity-checks-orchestrator
- Type: role-orchestrator
- Roles: architect
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates only
- Returns: decision summary — per-check script contract (name, inputs, exit codes), authenticity mechanics choice, re-approval handling, append-only diff strategy, max 30 lines
- Description: "Owns the new fail-closed integrity scripts: approval-ancestry + fingerprint re-check at the PR head, the approval-authenticity check (introducing-commit authored by the configured architect, proxy-approval aware), events.jsonl append-only + schema validation, and the advisory-only stale owner-claimed annotation. Delegate here for anything touching these checks' mechanics or their reading of gates.js/events.js/plan-fingerprint.js behavior. Hard constraints: CI calls the fold, never changes it — harness/gates.js and the events writer are read-only surfaces; ownership events must never block merge. Architect-only."

### integrity-surface-mapper
- Type: context-tool
- Roles: architect
- Model: claude-haiku-4-5-20251001
- Tools: Read, Grep, Glob
- Reads: harness/gates.js, harness/events.js (schema + fold exclusions), harness/plan-fingerprint.js, harness/adapters/git-state-store.js (recordApproval, proxy fields), scripts/git-sync.sh (divergence exit codes), .agents/state/*/events.jsonl (shape samples only)
- Returns: file:line anchors + event/fingerprint-shape notes (approved-event fields incl. proxy/recordedBy, fingerprint computation inputs, fold-excluded event types, divergence signal vocabulary) — never raw file contents, max 40 lines
- Description: "MUST BE USED by integrity-checks-orchestrator when mapping the gate fold, the approved-event schema (including proxy recordedBy fields), fingerprint computation, recordApproval provenance freezing, ownership-event fold exclusion, or git-sync divergence signals. Returns file:line anchors and event-shape notes — never raw file contents."

### convention-lints-orchestrator
- Type: role-orchestrator
- Roles: architect
- Model: claude-sonnet-4-6
- Tools: Task
- Reads: nothing — delegates only
- Returns: decision summary — agent-file lint rule set, scope-map sync strategy, scope-check/plan-lint CI invocation shape, max 30 lines
- Description: "Owns the repo-convention lints: the new agent-file frontmatter lint (.claude/agents/* required fields, context-tool model/tool rules, description prefixes), CLAUDE.md scope-map ↔ agent-files sync check, and the tail-wave CI wiring of check-scope.sh (fail-closed, blocks merge) and lint-plan.sh (advisory). Delegate here for anything touching these lint scripts or their CI surfacing. Hard constraint: reuse existing scripts via their CLI — never reimplement matching logic; new lints follow the plan-paths.sh one-source-of-truth pattern. Architect-only."

### lint-surface-mapper
- Type: context-tool
- Roles: architect
- Model: claude-haiku-4-5-20251001
- Tools: Read, Grep, Glob
- Reads: scripts/lint-plan.sh, scripts/check-scope.sh, scripts/lib/plan-paths.sh, .claude/agents/*.md (frontmatter samples only), CLAUDE.md Agent Scope Map section
- Returns: file:line anchors + lint-surface notes (existing matcher/output conventions, frontmatter field inventory across agent files, scope-map table shape and drift candidates) — never raw file contents, max 40 lines
- Description: "MUST BE USED by convention-lints-orchestrator when mapping lint-plan.sh/check-scope.sh output conventions, the plan-paths.sh shared-matcher pattern, agent-file frontmatter shapes, or the CLAUDE.md scope-map table structure. Returns file:line anchors and lint-surface notes — never raw file contents."

## Scope Map

| Agent | Type | Reads | Roles |
|-------|------|-------|-------|
| harness-ci-parent-orchestrator | parent-orchestrator | nothing | architect |
| ci-wiring-orchestrator | role-orchestrator | nothing | architect |
| ci-surface-mapper | context-tool | scripts/*.sh conventions, deliver-gate-hook.mjs, platform scripts, harness test entries | architect |
| integrity-checks-orchestrator | role-orchestrator | nothing | architect |
| integrity-surface-mapper | context-tool | gates.js, events.js, plan-fingerprint.js, git-state-store.js recordApproval, git-sync.sh, events.jsonl samples | architect |
| convention-lints-orchestrator | role-orchestrator | nothing | architect |
| lint-surface-mapper | context-tool | lint-plan.sh, check-scope.sh, lib/plan-paths.sh, .claude/agents samples, CLAUDE.md scope map | architect |

## Notes

- **All architect-only, matching the research ruling** — enforcement infrastructure
  end to end, unlike the developer-open insights feature. This follows the repo's
  default convention with no overrides.
- **Three orchestrators because all three domains own distinct code:** workflow YAML
  (wiring), brand-new integrity scripts (integrity), and lint scripts old + new
  (lints). The scripts-first invariant is held by the parent so no single
  orchestrator can quietly move check logic into YAML.
- **The research's open questions route cleanly:** authenticity mechanics +
  re-approval handling + findings.jsonl append-only inclusion → integrity-checks;
  runner-neutral annotation contract → ci-wiring; architect-identity/proxy mapping
  spans both (integrity owns the matching rule, wiring owns where identity config is
  read from — the plan should pin this seam explicitly).
- **Phasing preserved:** Layer 1 + integrity core sit in ci-wiring + integrity-checks;
  the droppable tail (scope-check/plan-lint CI wiring) is isolated inside
  convention-lints, so dropping it orphans nothing.
- **Mapper overlap with prior features is deliberate:** integrity-surface-mapper's
  scope overlaps event-fold-mapper/approval-event-mapper (different feature, same
  surface). Scope maps are per-feature read boundaries, not exclusive locks.
