# Plan: Self-Protection Paths
Created: 2026-07-22
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-07-22T13:57:31.545Z
Recorded-By: sean@torchcodelab.com
Branch: rad/self-protection-paths
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/73
Issue-Title: Self-protection: RAD's own harness/gate/script paths are unconditionally high-risk — no auto-clear path may ever clear a change to itself

## Context

`classify-low-risk.sh` (severity routing, #37) consults only operator-configurable patterns: a sufficiently broad `RAD_LOW_RISK_PATTERNS` (e.g. `.*`) can today auto-clear a plan that edits the classifier itself, and an overridden `RAD_HIGH_RISK_PATTERNS` silences the advisory for such a plan entirely. BEAKON's production green lane closes this with a "trust-inversion" guard (its gate force-routes changes to its own files); core has no equivalent. This plan adds a built-in, deliberately NON-configurable self-protected path set — matched once in `scripts/lib/plan-paths.sh` — that `classify-low-risk.sh` checks before any operator pattern and `lint-plan.sh` flags regardless of operator overrides.

## Scope

| In scope | Out of scope |
|---|---|
| `scripts/lib/plan-paths.sh` — self-protected pattern constant + matcher function | Green lane itself (#75) — this is its floor, not its implementation |
| `scripts/classify-low-risk.sh` — rule 0: self-protected ⇒ not-low, before all operator rules | Any operator config surface for the set (non-configurability is the point) |
| `scripts/lint-plan.sh` — unconditional self-protection advisory | `check-scope.sh` `ALWAYS_ALLOW_PREFIXES` (deliver-time diff allowances — different layer) |
| Tests in both co-located `test-*.sh` files | `deliver-gate-hook.mjs` (approval gate only; no pattern logic) |
| `CLAUDE.md` + `.env.example` documentation | Backporting to BEAKON/agentx3 |

## Acceptance Criteria

1. `classify-low-risk.sh` exits 1 (not-low) with a reason naming the self-protected path for any plan whose scope-path set touches the self-protected set — even with `RAD_LOW_RISK_PATTERNS='.*'` and `RAD_HIGH_RISK_PATTERNS` set empty.
2. `lint-plan.sh` emits a self-protection warning (distinct wording from the operator high-risk advisory) for such paths in every env-var state — default, overridden to a non-matching pattern, and empty — and still exits 0 (advisory-only, per the existing warning contract).
3. The self-protected pattern and its matcher are defined exactly once, in `scripts/lib/plan-paths.sh`; both consumers call the shared function (no second matcher).
4. Plans touching no self-protected path behave byte-for-byte as today: a docs-only plan still classifies low under the default allowlist; no new warnings appear for it.
5. `CLAUDE.md` (RAD Configuration) and `.env.example` document the set as built-in and non-configurable, listing the covered paths for transparency.

## Agent Scope

- `classifier-surface-mapper` (research) — mapped classify/lint/lib anchors, test conventions, doc anchors. No out-of-scope dependencies: all touched files sit inside the severity-classifier surface. (Note: `severity-classifier-orchestrator` failed to spawn — stale `Task` tools frontmatter; mapper was invoked directly. Repo fix candidate, out of scope here.)

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| scripts/lib/plan-paths.sh | append after 72 | `RAD_SELF_PROTECTED_PATTERN` constant + `path_is_self_protected()` |
| scripts/classify-low-risk.sh | ~63-80 | rule 0: self-protected scan before operator-pattern rules |
| scripts/lint-plan.sh | ~178-193 | unconditional self-protection warning loop alongside the gated high-risk loop |
| scripts/test-classify-low-risk.sh | append cases | AC#1 fixtures (broad allowlist + machinery path; empty high-risk) |
| scripts/test-lint-plan.sh | append cases | AC#2 fixtures (three env states) + AC#4 no-false-positive |
| CLAUDE.md | ~203-261 region | "Self-Protected Paths" subsection under RAD Configuration |
| .env.example | ~49-61 region | comment block: set exists, is built-in, cannot be overridden |

## Execution Notes

### Do Not Touch
- harness/gates.js, harness/events.js — gate fold and writer purity; this feature is entirely script-side
- scripts/check-scope.sh — its `ALWAYS_ALLOW_PREFIXES` serves deliver-time process artifacts and must not be conflated with classification
- scripts/deliver-gate-hook.mjs

### Key Files
- scripts/lib/plan-paths.sh — the one-source-of-truth matcher (`path_matches`, `plan_scope_paths`) this extends; bash 3.2 portable, no state
- scripts/classify-low-risk.sh — fail-closed rule ordering the new rule 0 must precede
- scripts/test-classify-low-risk.sh — temp-git-repo fixture convention: test paths must exist on the fixture's main branch; env vars set in subshells

### Reminders
- bash 3.2 compatibility throughout (no `mapfile`, no associative arrays, no bash-4-isms)
- `path_matches` treats an empty pattern as no-match (OFF); the self-protected constant must therefore never be empty, and `path_is_self_protected` must not route through any env var
- In classify, report the self-protected reason BEFORE high-risk tie reporting so the verdict names the strongest rule
- The self-protected pattern anchors on repo-relative paths (`^harness/`, `^scripts/`, `^\.claude/`, `^\.agents/state/`, `(^|/)gates\.ya?ml$`, `(^|/)matrix\.ya?ml$`)

## Wave Plan

### Wave 1 — sequential
Foundation: the shared matcher must exist before consumers use it. (Wave 2 tasks are the independent consumers; Wave 3 documents the landed behavior.)

#### Task 1.1: Self-protected pattern + matcher in the shared lib
File: scripts/lib/plan-paths.sh:72
What: Append `RAD_SELF_PROTECTED_PATTERN` (readonly constant: `^harness/|^scripts/|^\.claude/|^\.agents/state/|(^|/)gates\.ya?ml$|(^|/)matrix\.ya?ml$`) and `path_is_self_protected <path>` delegating to `path_matches` with that constant. Constant is a literal — no env-var indirection, matching the issue's non-configurability requirement. Comment states the constraint: this set is deliberately not operator-tunable; additions require a reviewed commit.
Validate: AC#3 — grep confirms the pattern string appears exactly once in the repo; both consumers (Tasks 2.1, 2.2) call `path_is_self_protected`.

### Wave 2 — parallel
Independent consumers of the Wave 1 function, plus docs.

#### Task 2.1: Rule 0 in the classifier + tests
File: scripts/classify-low-risk.sh:63-80
What: After `SCOPE_PATHS` is computed and before the existing high/low pattern loop, scan every scope path with `path_is_self_protected`; on first match exit 1 with `verdict: not-low` and `reason: self-protected path (RAD machinery): <path>`. Runs regardless of `RAD_LOW_RISK_PATTERNS` / `RAD_HIGH_RISK_PATTERNS` values. Extend scripts/test-classify-low-risk.sh: (a) `RAD_LOW_RISK_PATTERNS='.*'` + plan scoping `harness/gates.js` → exit 1, reason contains "self-protected"; (b) same with `scripts/classify-low-risk.sh` as the scoped path and `RAD_HIGH_RISK_PATTERNS=` (empty) → exit 1; (c) `.agents/state/demo/events.jsonl` scoped → exit 1; (d) docs-only plan under default allowlist → still exit 0 (regression, AC#4). Fixture paths committed to the temp repo's main per convention.
Validate: AC#1, AC#4 — `scripts/test-classify-low-risk.sh` exits 0 with the new cases.

#### Task 2.2: Unconditional advisory in the lint + tests
File: scripts/lint-plan.sh:178-193
What: Add a self-protection warning loop over `plan_scope_paths` output using `path_is_self_protected`, NOT gated on `RAD_HIGH_RISK_PATTERNS` being non-empty; warning text "self-protected path (RAD machinery — never auto-clearable): <path>", appended to `WARNINGS[]` (advisory contract unchanged, exit stays 0). Extend scripts/test-lint-plan.sh: warning fires with (a) default env, (b) `RAD_HIGH_RISK_PATTERNS='zzz-nomatch'`, (c) `RAD_HIGH_RISK_PATTERNS=` empty; (d) docs-only plan produces no self-protection warning.
Validate: AC#2, AC#4 — `scripts/test-lint-plan.sh` exits 0 with the new cases.

### Wave 3 — parallel
Documentation of the behavior landed in Wave 2.

#### Task 3.1: Documentation — CLAUDE.md
File: CLAUDE.md:203-261
What: Add a "Self-Protected Paths" subsection to the RAD Configuration section (after severity routing): the built-in set, why it is non-configurable (no auto-clear path may ever clear a change to itself; BEAKON trust-inversion provenance, #73), and that it wins over any operator allowlist including `.*`.
Validate: AC#5 — CLAUDE.md contains the subsection; `scripts/lint-plan.sh` on this plan still passes.

#### Task 3.2: Documentation — .env.example
File: .env.example:49-61
What: Add a comment block near the RAD_*_PATTERNS vars: the self-protected set exists, is intentionally not an env var, and is listed here for transparency only (with the covered path prefixes).
Validate: AC#5 — .env.example contains the block.

## Tests to Write
- [ ] classify: broad allowlist `.*` + `harness/gates.js` scoped → not-low, reason "self-protected" — scripts/test-classify-low-risk.sh
- [ ] classify: empty `RAD_HIGH_RISK_PATTERNS` + `scripts/classify-low-risk.sh` scoped → not-low — scripts/test-classify-low-risk.sh
- [ ] classify: `.agents/state/` path scoped → not-low — scripts/test-classify-low-risk.sh
- [ ] classify: docs-only plan under default allowlist → still low (no regression) — scripts/test-classify-low-risk.sh
- [ ] lint: self-protection warning under default, overridden, and empty `RAD_HIGH_RISK_PATTERNS`; exit 0 — scripts/test-lint-plan.sh
- [ ] lint: docs-only plan → no self-protection warning — scripts/test-lint-plan.sh

## Non-Goals
- Implementing green lane (#75) or shadow calibration (#76) — this is their precondition only
- Any operator override/config surface for the self-protected set (an escape hatch would defeat the guard; changing the set means editing the lib in a reviewed commit)
- Extending `check-scope.sh` or the deliver-gate hook — different enforcement layers
- Blocking at lint time — lint stays advisory; the hard stop lives in classification (and, later, the green-lane gate that consumes it)

## Out-of-Scope Dependencies
None — all files sit inside the severity-classifier/lint surface.

## Risks
- Over-inclusion: `^scripts/` and `^\.claude/` cover every operator script and prompt surface, so some benign changes lose auto-clear eligibility. This fails toward the human gate — the safe direction — and costs nothing today (severity routing is opt-in and the advisory is a warning).
- Self-referential: this plan itself scopes `scripts/` files, so once Task 2.2 lands, `lint-plan.sh` on this very plan will emit the new self-protection warning. Expected and correct — it is the trust inversion demonstrating itself; not a test failure.

## Issue Gaps
- **Exact set membership.** The issue names categories; this plan resolves them to a concrete regex, and resolves "settings + hooks" to **all of `^\.claude/`** (commands/agents/skills included) on the reasoning that prompt surfaces are trust surfaces — broader than the issue's letter. Assumption for the architect to verify at approval.
- **`gates.yaml` / `matrix.yaml` matched anywhere in the tree** (`(^|/)` anchor) rather than at a pinned path, since the issue doesn't fix their location. Assumption: no legitimate non-RAD file shares these names.
- **Reason-string format** (`self-protected path (RAD machinery): <path>`) is asserted by tests but not consumed by any event writer today; #75 will freeze whatever string exists into approval evidence. Assumption: format is free to stabilize now.
