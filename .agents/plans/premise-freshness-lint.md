# Plan: Premise-Freshness Lint
Created: 2026-07-24
Author: architect
Status: complete
Completed-At: 2026-07-24T13:55:55Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-07-24T13:36:44.436Z
Recorded-By: sean@torchcodelab.com
Branch: rad/premise-freshness-lint

## Context
`scripts/lint-plan.sh` and `scripts/classify-low-risk.sh` reason over a plan's declared
path set (via `scripts/lib/plan-paths.sh`) but never check whether those paths still
exist on the base ref — so a plan anchored to deleted/renamed code passes clean and only
fights the tree at deliver time (the "develop-drift" failure class, issue #74). This adds
a base-ref existence check: cited `path:line` anchors, per-task `File:` paths, and
Files-in-Scope entries must name files that exist on `origin/<default_branch>`, unless the
plan itself creates them. Advisory in `lint-plan.sh`; eligibility-blocking in the
auto-clear path (`classify-low-risk.sh`).

## Scope
| In scope | Out of scope |
|---|---|
| New extraction/existence helpers in `plan-paths.sh` (anchors, created-paths, base-ref existence) | Modifying `RAD_SELF_PROTECTED_PATTERN` or any existing matcher semantics |
| Advisory freshness block in `lint-plan.sh` (warning, never errors) | Verifying line numbers (existence only — line ranges are too brittle) |
| Eligibility block in `classify-low-risk.sh` (stale premise ⇒ not-low) | Any implicit `git fetch` / network call — checks query the locally-known ref only |
| Co-located tests for all three scripts | `.claude/commands/team/rad-review.md` (advisory surfaces automatically, no edit) |

## Acceptance Criteria
1. `plan-paths.sh` exposes three new reusable helpers — an inline `path:line` anchor extractor, a created-paths (CREATE-exempt) detector, and a base-ref existence checker — and both consumer scripts use them (one source of truth; no second matcher).
2. `lint-plan.sh` emits an advisory **warning** (exit 0 preserved) for any non-exempt cited anchor / per-task `File:` path / Files-in-Scope entry that is absent on `origin/<default_branch>`.
3. `classify-low-risk.sh` returns **not-low** (eligibility-blocking, via `not_low`) when any non-exempt declared path is absent on the base ref — a stale-premise plan is never auto-clearable.
4. A path the plan creates (Files-in-Scope col-3 == `new file`, or col-4 matching `^New`) is **exempt** from both checks and never flagged as stale.
5. Both checks **fail-closed** on an unresolvable base ref: `lint-plan.sh` warns that freshness could not be verified; `classify-low-risk.sh` returns not-low.
6. Line numbers are never verified — only path existence; an anchor `path:120` checks `path`.

## Agent Scope
- Explore (research only) — bounded summary consumed to write this plan. No implementation agents required.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/lib/plan-paths.sh | 87 | Add `plan_cited_anchors`, `plan_created_paths`, `path_exists_on_ref` helpers |
| scripts/lint-plan.sh | 302 | Add freshness advisory block after the self-protected block (~206) |
| scripts/classify-low-risk.sh | 137 | Add stale-premise eligibility block alongside Rule 0 |
| scripts/test-plan-paths.sh | new file | Unit tests for the three new helpers |
| scripts/test-lint-plan.sh | 217 | Add freshness advisory cases (git-backed fixture) |
| scripts/test-classify-low-risk.sh | 277 | Add stale-premise not-low cases |

## Execution Notes

### Do Not Touch
- `RAD_SELF_PROTECTED_PATTERN` in `scripts/lib/plan-paths.sh` — reviewed literal; extend only by adding new helper functions, never weaken the constant.
- `.claude/commands/team/rad-review.md` — Step 2b already includes full `lint-plan.sh` output as advisory; a new WARNINGS entry surfaces with no edit.

### Key Files
- `scripts/lib/plan-paths.sh` — the one-source-of-truth matcher; all new extraction/existence logic lands here so both consumers share it.
- `scripts/classify-low-risk.sh` — resolves `BASE_BRANCH` via `get-default-branch.sh` and already uses `origin/$BASE_BRANCH` + fail-closed-on-undetectable-diff; mirror that idiom for base-ref existence.
- `scripts/test-classify-low-risk.sh` — builds a real git repo fixture with an `origin` remote; the template for git-backed base-ref tests.

### Reminders
- No implicit `git fetch`. Both checks query the locally-known `origin/<default_branch>` ref via `git cat-file -e "origin/<base>:<path>"`. If that ref is unresolvable locally, treat as fail-closed (AC#5) — keeps `lint-plan.sh` offline-pure like the rest of it.
- Existence only. Strip the `:NNN` suffix (reuse `strip_task_file_lines` semantics) before the existence query (AC#6).
- Anchors inside fenced code blocks are still checked — keep the extractor dumb; documented as intended, not a bug.

## Wave Plan

### Wave 1 — sequential
Foundation: the shared helpers every consumer depends on.

#### Task 1.1: Add anchor / created-paths / base-ref helpers to plan-paths.sh
File: scripts/lib/plan-paths.sh:62-87
What: Add three functions after the existing extractors. `plan_cited_anchors <plan>` scans the whole plan body for `path/to/file.ext:NNN`-shaped tokens and prints each path with the `:NNN` suffix stripped (reuse `strip_task_file_lines` semantics), de-duplicated. `plan_created_paths <plan>` prints Files-in-Scope paths whose Lines column is `new file` or whose Change column matches `^New\b` — the CREATE-exempt set. `path_exists_on_ref <path> <ref>` returns 0 iff `git cat-file -e "$ref:$path"` succeeds, non-zero on absence, and a distinct non-zero (or a documented sentinel) when `$ref` itself is unresolvable so callers can fail-closed. No existing function's behavior changes.
Validate: AC#1 (helpers exist and are sourced by both consumers), AC#4 (created-paths detection: col-3 `new file` and col-4 `^New`), AC#6 (suffix stripped before existence). Edge cases tested in test-plan-paths.sh: anchor with `:NNN` suffix; anchor without a suffix (bare path in prose — not extracted as anchor); path present vs absent on a fixture ref; unresolvable ref returns the fail-closed signal; `new file` and `New —` rows both detected as created; empty plan / no anchors → empty output (not an error).

#### Task 1.2: Co-locate unit tests for the new helpers  ← same commit as 1.1
File: scripts/test-plan-paths.sh:new file
What: New test harness (mirror `test-classify-low-risk.sh` git-fixture style: `git init`, baseline commit on `main`, an `origin`). Assert each helper: `plan_cited_anchors` extracts inline `path:NNN` and strips the suffix, ignores non-anchor prose; `plan_created_paths` returns exactly the `new file` / `^New` rows; `path_exists_on_ref` is 0 for a committed path, non-zero for an absent path, and fail-closed for a bogus ref. End with `echo "ALL PASS"`. Registered in CI alongside the other `scripts/test-*.sh`.
Validate: AC#1, AC#4, AC#6 — each helper has a direct unit test; this is the "test in the same commit" surface for Wave 1 (satisfies the co-located-test convention for the library change).

### Wave 2 — parallel
Depends on: Wave 1 complete. Two independent consumers of the Wave 1 helpers.

#### Task 2.1: Freshness advisory in lint-plan.sh + tests
File: scripts/lint-plan.sh:195-206
What: After the self-protected advisory block, resolve the base ref (`get-default-branch.sh` → `origin/<default_branch>`). Build the check set = union of `plan_cited_anchors`, `plan_task_files`, `plan_files_in_scope`, minus `plan_created_paths`. For each, if `path_exists_on_ref` reports absent, `WARNINGS+=("stale premise: <path> not found on <base> — plan written against removed/renamed code")`. If the base ref is unresolvable, push one warning that freshness could not be verified. Never push to ERRORS — exit code stays 0. Add cases to `scripts/test-lint-plan.sh` using a git-backed fixture (borrow the `test-classify` repo setup).
Validate: AC#2 (absent path → warning, exit 0), AC#4 (created path → no warning), AC#5 (unresolvable ref → advisory, still exit 0), AC#6 (line number never checked). Edge cases: existing path → no warning; deleted path → warning naming path + base; anchor in a fenced block → still checked; plan with no anchors and all-existing paths → no freshness warnings; exit 0 in every case.

#### Task 2.2: Stale-premise eligibility in classify-low-risk.sh + tests
File: scripts/classify-low-risk.sh:62-96
What: Add a rule adjacent to Rule 0 (self-protected), using the already-resolved `BASE_BRANCH`. Build the same check set (union of anchors + `File:` + Files-in-Scope, minus created-paths). If any member is absent on `origin/$BASE_BRANCH`, call `not_low "stale premise: <path> absent on <base>"`. If the base ref is unresolvable, `not_low` (fail-closed, mirroring the existing undetectable-diff handling). Runs before the low/high pattern rules so the verdict names the strongest reason. Add cases to `scripts/test-classify-low-risk.sh`.
Validate: AC#3 (stale path ⇒ not-low), AC#4 (created path is not treated as stale — a plan creating a new file stays eligible on that axis), AC#5 (unresolvable ref ⇒ not-low). Edge cases: all paths present + otherwise-low plan → still low; one absent path → not-low naming it; created new file only → not flagged stale; empty scope → existing "no paths in scope" not-low unchanged.

## Tests to Write
- [ ] `plan_cited_anchors` / `plan_created_paths` / `path_exists_on_ref` unit cases — scripts/test-plan-paths.sh
- [ ] Freshness advisory: absent path warns, created path exempt, unresolvable ref advises, exit 0 always — scripts/test-lint-plan.sh
- [ ] Stale-premise eligibility: absent path ⇒ not-low, created path stays eligible, unresolvable ref ⇒ not-low — scripts/test-classify-low-risk.sh

## Non-Goals
- Verifying line numbers or line ranges — existence only (they drift too easily to gate on).
- Introducing any network `git fetch` into the lint/classify path — checks read the locally-known ref only.
- Changing how `/rad-review` surfaces lint output — the advisory rides the existing Step 2b inclusion.
- Auto-correcting or rewriting stale anchors — the checks report; the author fixes.

## Out-of-Scope Dependencies
None — all files are under `scripts/`, within architect (full-repo) scope.

## Risks
- All touched files are RAD self-protected machinery, so this plan will (correctly) trip the self-protected advisory and be non-auto-clearable — expected per #73, not a conflict; it must go through architect approval.
- The anchor extractor could over-match `path:NNN`-shaped tokens that aren't real file references (e.g. a URL, a time, `AC#3` style refs). Mitigation: match only tokens with a filesystem-path shape (contains `/` or a known extension) and rely on existence-check-then-warn — a false positive surfaces as an advisory, never a hard block in lint; in classify it is fail-closed by design, so tighten the extractor's shape rule and test the ambiguous cases explicitly.
- Adding base-ref resolution to `lint-plan.sh` (previously pure-local) — mitigated by querying the already-fetched `origin/<base>` ref with no implicit fetch, and failing closed to an advisory rather than an error.
