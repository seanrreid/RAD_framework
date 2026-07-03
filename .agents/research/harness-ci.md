# Research: Harness CI
Created: 2026-07-03
Author: architect
Status: pending-design
Source: inline — session discussion (2026-07-03) following the agent-reliability-stack
review; CI-specific ownership/authenticity rulings recorded same session.

## Project Summary
CI for the RAD framework repo itself, as a second, machine-independent enforcement
point for invariants currently checked only inside a local Claude session. Layer 1:
ordinary test CI (the `harness/` `node --test` suite + `scripts/test-*.sh`) on every
PR. Layer 2: agent-harness-specific deterministic checks — gate integrity on deliver
PRs (approval ancestry + fingerprint + authenticity), event-log append-only
enforcement, agent-file/scope-map lint, and (tail) merge-blocking scope check and
plan-lint surfacing. All checks are platform-agnostic scripts with a default GitHub
Actions wrapper.

## Key Requirements
- **Layer 1 — test CI.** Run `node --test` in `harness/` and the `scripts/test-*.sh`
  suite on every PR. Red tests block merge.
- **Gate-integrity check (deliver PRs, fail-closed).** Re-run the pure gate fold at
  the PR head: the `approved` event must be an **ancestor of the merge candidate**,
  and its frozen plan fingerprint must match the plan doc at that commit. An approval
  on some other (diverged/unpushed) tip does not count — the PR head is the single
  proposed truth. No remote state, no ownership arbitration at CI time.
- **Approval-authenticity check (deliver PRs, fail-closed, CORE wave).** Verify the
  commit that *introduced* the `approved` event line was authored by the configured
  architect identity. Closes the fabricated/force-pushed-approval hole the fold
  cannot see (it validates consistency, not authenticity). The one check nothing
  local can perform.
- **Event-log append-only check (all PRs, fail-closed).** Fail any PR whose diff
  modifies or deletes existing lines in any `events.jsonl`; appended lines must
  schema-validate.
- **Agent-file lint + scope-map sync (all PRs, fail-closed).** Validate
  `.claude/agents/*.md` frontmatter (required fields; context tools are haiku with no
  Task; descriptions start "MUST BE USED"/"Use PROACTIVELY") and that the CLAUDE.md
  Agent Scope Map stays in sync with the agent files on disk.
- **Ownership events: advisory only.** A stale unreleased `owner-claimed` on a
  deliver PR surfaces as a non-blocking PR annotation — never a failure. Ownership
  events are data-only write-coordination (deliberately absent from the fold);
  CI must not make them load-bearing.
- **Scope check (deliver PRs, fail-closed, tail wave).** `check-scope.sh` against the
  plan; out-of-scope files **block merge** (session ruling — not advisory).
- **Plan lint (PRs touching `.agents/plans/`, advisory, tail wave).** Surface
  `lint-plan.sh` output in the PR; stays a warning, matching its local semantics.
- **Scripts-first, one source of truth.** Every check is a standalone script,
  callable locally and from CI (the `plan-paths.sh` pattern). New checks
  (append-only diff, agent-file lint, approval ancestry/authenticity) land as
  scripts before any workflow references them. Existing scripts are reused, never
  reimplemented in workflow YAML.
- **Platform-agnostic with a GHA default.** Workflow YAML is a thin wrapper over the
  scripts; adopters on gitlab/bitbucket/forgejo wire the same scripts into their
  runner. GitHub Actions is the default shipped wrapper, swappable.
- **CI calls the fold, never changes it.** `harness/gates.js` and the events writer
  are read-only surfaces for this feature.
- **Deliver-PR detection.** Deliver-specific checks detect "rad/ branch with a plan"
  and no-op cleanly (success, explicit skip notice) on ordinary PRs.
- **Local enforcement unchanged.** The PreToolUse deliver-gate hook and /rad-review
  stay as-is; CI is additive.

## Domains

| Domain | Description | Sensitivity |
|--------|-------------|-------------|
| CI workflow wiring | `.github/workflows/` job structure, triggers, deliver-PR detection, PR annotations; thin wrapper over scripts | architect-only |
| Gate & event integrity checks | Approval ancestry + fingerprint re-check, authenticity (commit-author) check, append-only enforcement, ownership advisory — new scripts reading gates.js/events.js behavior | architect-only |
| Repo-convention lints | Agent-file frontmatter lint, CLAUDE.md scope-map sync, scope-check and plan-lint CI wiring — mostly wrapping existing scripts | architect-only |

Sensitivity rationale: CI enforcing the gate is the determinism boundary's outer
wall — enforcement infrastructure end to end, unlike the read-only insights feature.
All three domains architect-only (session ruling).

## Team

architect: sean@torchcodelab.com
developers: unassigned
designers: none

## Platform

platform: github
default_branch: main

## Constraints
- Node >=18, no new runtime dependencies (harness convention).
- Fail-closed semantics for integrity checks; advisory-only where the local
  counterpart is advisory (plan lint) or where the event is data-only (ownership).
- Phasing: Layer 1 + integrity core (gate ancestry/fingerprint, authenticity,
  append-only, agent-file lint) as core waves; scope-check + plan-lint wiring as a
  droppable tail wave.
- Branch protection (no force-push on rad/*, required reviews) is the assumed
  platform substrate beneath the authenticity check — document as an adopter
  prerequisite, not RAD code.
- Architect identity for the authenticity check comes from the CLAUDE.md Role
  Assignments block (or an env override) — resolution mechanism is a design
  decision.

## Open Questions
- Authenticity-check mechanics: `git log -L`/blame on the events file vs walking
  commits that touch it — design decision; must handle multi-approval histories
  (re-approvals) by checking the *gating* event's introducing commit.
- Architect-identity matching: git author email vs committer, and how proxy
  approvals (`--on-behalf-of`, `recordedBy`) map to expected commit authorship.
- Whether the append-only check also covers `findings.jsonl` (same append-only
  convention, lower stakes) — cheap to include, decide in design.
- PR-annotation mechanism for advisories on non-GitHub platforms (GHA default uses
  workflow annotations; script output contract must stay runner-neutral).
