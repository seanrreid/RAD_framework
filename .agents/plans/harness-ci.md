# Plan: Harness CI
Created: 2026-07-03
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-07-03T15:29:10.196Z
Recorded-By: sean@torchcodelab.com
Branch: rad/harness-ci

## Context
RAD has no CI: `.github/workflows/` does not exist, so the 21-file harness test
suite and the `scripts/test-*.sh` fixtures run on the honor system, and every
integrity invariant (gate authority, append-only event logs, agent-file
conventions) is enforced only inside a local Claude session. This plan adds CI as
a second, machine-independent enforcement point: Layer-1 test jobs plus new
fail-closed check scripts, per the approved harness-ci architecture. All check
logic lives in standalone scripts (callable locally with identical semantics);
workflow YAML is a thin wrapper.

## Scope
| In scope | Out of scope |
|---|---|
| New check scripts: approval integrity (ancestry+fingerprint+gate+authenticity+ownership advisory), events append-only, agent-file lint + scope-map sync | Any change to harness/gates.js, events.js, plan-fingerprint.js, git-state-store.js — CI calls the fold, never changes it |
| Co-located test-*.sh for each new script | The local PreToolUse deliver-gate hook and scripts/hooks/* (separate enforcement point, unchanged) |
| .github/workflows/ci.yml thin wrapper (Layer-1 tests + check jobs, deliver-PR detection, annotations) | Non-GitHub runner wrappers (scripts stay runner-neutral; adopters wire their own) |
| Tail: CI wiring of existing check-scope.sh (merge-blocking) + lint-plan.sh (advisory) | Modifying check-scope.sh / lint-plan.sh logic itself |
| .env.example + docs/rad-cli.md documentation | Branch-protection settings (documented as adopter prerequisite, not code) |

## Acceptance Criteria
1. On every PR, CI runs the harness `node --test` suite and all `scripts/test-*.sh`; any failure fails the workflow.
2. On a deliver PR (`rad/` branch with a matching plan), CI fails unless the `approved` event is an ancestor of the PR head, its frozen `data.fingerprint` matches `rad plan-fingerprint` of the plan at the head, and `rad gate <feature> approved --stdin` passes — all via existing cli.js primitives, no reimplemented folding or hashing.
3. On a deliver PR, CI fails when the commit that introduced the gating `approved` event line was not authored by the architect configured in CLAUDE.md Role Assignments (proxy-aware: `recordedBy` events resolve against the same identity rules check-role.sh uses).
4. Any PR whose diff modifies or deletes an existing line in any `.agents/state/*/events.jsonl` fails; appended lines must parse as JSON with the required event fields (`feature`, `type`, `actor`, `ts`).
5. A stale unreleased `owner-claimed` on a deliver PR produces a non-blocking annotation and never a failure.
6. A PR with an agent file violating frontmatter conventions (missing required fields; context tool not on claude-haiku or carrying Task; description not starting "MUST BE USED"/"Use PROACTIVELY"), or with drift between the CLAUDE.md Agent Scope Map table and `.claude/agents/` files on disk, fails; the check itself never edits any file.
7. On an ordinary (non-deliver) PR, deliver-only checks succeed with an explicit skip notice.
8. Every new check script runs locally with the same exit semantics as in CI (0 pass, 1 fail, 2 usage) and has a passing co-located `test-<name>.sh`.
9. On a deliver PR with out-of-scope changed files, the check-scope.sh CI job fails (merge-blocking); lint-plan.sh output surfaces as a non-blocking annotation on PRs touching `.agents/plans/`.

## Agent Scope
Research via Explore sub-agent within the architect-only harness-ci surfaces
(ci-surface-mapper, integrity-surface-mapper, lint-surface-mapper Reads columns).
No out-of-scope dependencies — all three domains are architect-owned.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/check-approval-integrity.sh | 1-220 | NEW — deliver-PR integrity: resolve feature/plan from branch, ancestry check (approved-event commit is ancestor of HEAD), fingerprint + gate via `rad plan-fingerprint` / `rad gate --stdin` (mirroring check-plan-approved.sh), authenticity (introducing commit author == configured architect, proxy-aware), stale owner-claimed advisory output |
| scripts/test-check-approval-integrity.sh | 1-130 | NEW — temp-git-fixture self-test per test-check-scope.sh pattern |
| scripts/check-events-append-only.sh | 1-120 | NEW — diff base...head; fail on modified/deleted events.jsonl lines; JSON + required-field validation on appended lines |
| scripts/test-check-events-append-only.sh | 1-90 | NEW — fixture self-test |
| scripts/lint-agent-files.sh | 1-150 | NEW — frontmatter lint over .claude/agents/*.md + CLAUDE.md scope-map sync (read-only; reports drift, never edits) |
| scripts/test-lint-agent-files.sh | 1-100 | NEW — fixture self-test |
| .github/workflows/ci.yml | 1-110 | NEW — Layer-1 test jobs + check jobs; deliver-PR detection (rad/ branch with plan, clean skip otherwise); annotations for advisories; tail wave adds scope/plan-lint jobs |
| .env.example | 66-75 | Document new CI env knobs (architect-identity override for authenticity check) in the commented-block style |
| docs/rad-cli.md | +40 | New "CI checks" section: each script's contract, local invocation, runner-neutral wiring, branch-protection prerequisite |

## Execution Notes

### Do Not Touch
- harness/gates.js — pure gate fold; invoke via `rad gate`, never edit
- harness/events.js — event model/writer contract; validate against it, never change it
- harness/adapters/git-state-store.js — write-time authority (recordApproval)
- harness/plan-fingerprint.js — single source of truth; call via `rad plan-fingerprint`, never re-hash in bash
- harness/spine.js — execution engine, out of CI scope
- scripts/deliver-gate-hook.mjs and scripts/hooks/* — existing local enforcement, unchanged
- scripts/check-scope.sh, scripts/lint-plan.sh — wired into CI as-is; logic untouched

### Key Files
- scripts/check-plan-approved.sh — the structural template for check-approval-integrity.sh: events-log resolution order (origin/work-branch → origin/base → local, fail-closed), fingerprint comparison, `rad gate --stdin` piping
- harness/cli.js (gateCommand ~1162-1213, plan-fingerprint ~903) — the reusable read-only primitives and their machine-greppable output
- scripts/check-role.sh — how architect identity is parsed from CLAUDE.md Role Assignments (authenticity check reads identity the same way; never re-derives)
- scripts/test-check-scope.sh — the canonical temp-git-fixture self-test pattern
- scripts/lib/plan-paths.sh — the shared-lib sourcing pattern for any shared bash logic
- .claude/agents/accessibility-reviewer.md — frontmatter shape reference for the lint

### Reminders
- bash 3.2 (macOS) compatible: no assoc arrays; `set -euo pipefail`; exit 0/1/2 convention.
- Fail-closed everywhere ambiguity arises (missing log, unparseable event, undeterminable ancestry) — EXCEPT: mirror check-plan-approved.sh's one deliberate narrow fail-open for legacy approved events with no `data.fingerprint`, to stay consistent with local gate semantics; and ownership advisories NEVER fail the job (AC#5).
- The scope-map sync check is read-only: CLAUDE.md's Agent Scope Map is /rad-design-generated ("Do not edit manually") — the lint reports drift, it must never rewrite the table.
- Authenticity: find the commit that introduced the *gating* approved line (`git log --diff-filter=AM -L` or line-porcelain blame on the events file); on re-approval histories the latest approved event is the gating one. Match git author email against the CLAUDE.md architect (env override documented in .env.example).
- Workflow YAML contains zero check logic — jobs only invoke scripts; advisory jobs use `continue-on-error` + annotations so they never gate merge.
- In CI the checkout IS the PR head: run checks against the checked-out tree/history; do not require network fetches beyond actions/checkout's `fetch-depth: 0` (needed for ancestry + base diffs).

## Wave Plan

### Wave 1 — parallel
Tasks in this wave can run in parallel (three independent new scripts, each with its co-located test).

#### Task 1.1: Approval-integrity check script
File: scripts/check-approval-integrity.sh:1-220
What: New deliver-PR check: resolve feature from the work branch and plan path; verify the commit introducing the gating `approved` event is an ancestor of HEAD; verify `data.fingerprint` matches `rad plan-fingerprint <plan>` and the gate passes via `rad gate <feature> approved --stdin` (mirror check-plan-approved.sh structure); verify the introducing commit's author matches the configured architect (proxy-aware); emit a non-failing advisory line for a stale unreleased `owner-claimed`. Ship scripts/test-check-approval-integrity.sh (fixture: approved/unapproved/tampered-fingerprint/wrong-author/stale-claim cases).
Validate: AC#2, AC#3, AC#5, AC#8 — test script passes locally; each fixture case exits with the documented code.

#### Task 1.2: Events append-only check script
File: scripts/check-events-append-only.sh:1-120
What: New all-PR check: `git diff base...head` over `.agents/state/*/events.jsonl`; fail on any modified/deleted existing line; validate appended lines parse as JSON carrying `feature`, `type`, `actor`, `ts`. Ship scripts/test-check-events-append-only.sh (fixture: pure-append pass, edit fail, delete fail, malformed-append fail).
Validate: AC#4, AC#8 — test script passes locally with documented exit codes.

#### Task 1.3: Agent-file lint + scope-map sync script
File: scripts/lint-agent-files.sh:1-150
What: New all-PR lint: every `.claude/agents/*.md` has required frontmatter (name, description, model, tools, roles); context tools (Read/Grep/Glob, no Task) must be claude-haiku models and descriptions must start "MUST BE USED"/"Use PROACTIVELY"; CLAUDE.md Agent Scope Map rows must biject with agent files on disk. Read-only — reports drift, never edits. Ship scripts/test-lint-agent-files.sh.
Validate: AC#6, AC#8 — test script passes locally; a seeded drift fixture fails, clean tree passes.

### Wave 2 — parallel
Depends on: Wave 1 complete (workflow invokes the Wave-1 scripts; docs describe them).

#### Task 2.1: CI workflow (Layer 1 + integrity checks)
File: .github/workflows/ci.yml:1-90
What: New workflow: on pull_request — job(s) running `npm test --prefix harness` (node --test) and every `scripts/test-*.sh`; check jobs invoking check-events-append-only.sh and lint-agent-files.sh (fail-closed); a deliver-PR job that detects `rad/` head branch with a matching `.agents/plans/` file, runs check-approval-integrity.sh, and skips with an explicit notice otherwise; ownership advisory surfaces via annotation, `continue-on-error`. `fetch-depth: 0` for ancestry/diffs. Zero check logic in YAML.
Validate: AC#1, AC#2, AC#7 — workflow YAML parses (actionlint or `gh workflow` dry check); ordinary-PR path shows the skip notice; jobs are script invocations only.

#### Task 2.2: Config + docs
File: .env.example:66-75; docs/rad-cli.md:+40
What: Document the architect-identity override env knob in .env.example's commented style; add a docs/rad-cli.md "CI checks" section covering each script's CLI contract, local invocation, the runner-neutral wiring intent (GHA is the default wrapper), and branch protection (no force-push on rad/*, required reviews) as the adopter prerequisite beneath the authenticity check.
Validate: AC#8 — docs list the same exit codes the scripts implement; .env.example block follows the existing commented pattern.

### Wave 3 — sequential (droppable tail)
Depends on: Wave 2 complete. This wave can be dropped without orphaning anything.

#### Task 3.1: Wire scope check (blocking) and plan lint (advisory) into CI
File: .github/workflows/ci.yml:91-110
What: Extend the deliver-PR job to run `scripts/check-scope.sh <plan> <branch> <base>` as a fail-closed, merge-blocking step; add a job on PRs touching `.agents/plans/**` running `scripts/lint-plan.sh` with `continue-on-error` + annotation (advisory, matching local semantics). No changes to either script.
Validate: AC#9 — an out-of-scope fixture branch fails the job; a plan-touching PR shows lint output without failing.

## Tests to Write
- [ ] scripts/test-check-approval-integrity.sh — fixture repo: approved+ancestor pass; unapproved fail; tampered fingerprint fail; non-architect author fail; proxy-approval pass; stale owner-claimed advisory-not-fail
- [ ] scripts/test-check-events-append-only.sh — pure append pass; modified line fail; deleted line fail; malformed JSON append fail; non-events file untouched
- [ ] scripts/test-lint-agent-files.sh — clean tree pass; missing frontmatter field fail; context tool with Task fail; scope-map drift (extra row / missing row) fail

## Non-Goals
- No changes to the gate fold, events writer, fingerprint computation, or any harness/ module — CI is strictly a caller.
- No non-GitHub workflow wrappers (GitLab/Bitbucket/Forgejo) — scripts stay runner-neutral; wiring them elsewhere is adopter work.
- No signing/GPG verification of commits — authenticity is author-identity matching; cryptographic attestation is future work.
- No auto-fixing: every check reports and exits; nothing edits CLAUDE.md, agent files, plans, or logs.

## Out-of-Scope Dependencies
None — all three domains are architect-only and the author is the architect.
Note: `.github/workflows/` is new surface not yet in any agent's Reads column;
it falls under ci-wiring-orchestrator's declared domain per the approved
architecture.

## Risks
- The authenticity check's line-introduction detection (`git log -L`/blame on events.jsonl) must handle merge commits and re-approval appends; wrong-commit attribution would fail-closed (annoying) rather than fail-open (dangerous), but fixtures must cover a merged-history case.
- `fetch-depth: 0` on large repos slows checkout; acceptable here, worth a comment in the workflow.
- The scope-map sync check will immediately enforce a bijection the repo only informally maintains — if any pre-existing drift exists at merge time, CI goes red on the first PR; the deliver wave should run the lint against the current tree and reconcile before wiring it in.
- Mirroring the legacy no-fingerprint fail-open keeps local/CI semantics identical but preserves that narrow hole; tightening it is a deliberate future decision, documented in docs/rad-cli.md.
