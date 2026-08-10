# Execution Log: Gate Legibility Lints
Plan: .agents/plans/gate-legibility-lints.md
Started: 2026-08-10T13:20:00Z
Branch: rad/gate-legibility-lints
Executor role: architect

## Steps

| Step | Wave | Task | Status | Commit | Time |
|------|------|------|--------|--------|------|
| 1 | Wave 1 | Fix the committed mode | ✓ complete | 44a7392 | 2026-08-10T13:56:36Z |
| 2 | Wave 1 | Committed-mode check in the shell-safety lint | ✓ complete (concerns) | d0b50ed | 2026-08-10T14:02:00Z |
| 3 | Wave 2 | Bare-basename resolution | ✓ complete | 8a8e9f3 | 2026-08-10T13:40:28Z |
| 4 | Wave 2 | Suppress the duplicate for plan-created files | ✓ complete | 8fc17b8 | 2026-08-10T13:44:16Z |

## Wave 1 — architect notes

**Concern raised (Task 1.2) and ruled on: AC#9 vs fixture setup.**
`git ls-files` exits 128 outside a repository, so the fail-closed requirement in
Task 1.2 is structurally incompatible with the existing fixtures being plain
scratch dirs — all 8 would have exited 2. The wave added an `init_fixture_repo`
helper so each fixture is a real repo.

Ruling: **accepted.** AC#9 requires existing suites to "pass unchanged in count
and outcome". Verified: the original 8 cases retain their descriptions, their
asserted exit codes (0/1/2), and their pass status; 3 new cases were appended
(9, 10, 11). Only fixture *setup* changed. The rejected alternative — scoping the
mode pass to the lint's own repo rather than `$SCRIPTS_DIR` — would have left zero
fixture churn but made the check untestable, which is the worse trade.

**Second concern, self-resolved:** the new `git -C "$SCRIPTS_DIR"` call violated
the lint's own tainted-input rule, taking the clean tree from exit 0 to exit 1.
Fixed with a shape guard on `$SCRIPTS_DIR` (exit 2 on whitespace/metacharacters)
rather than a baseline entry, so the Program Design note "no baseline entry
expected" still holds.

**Independently verified by the orchestrator before Wave 2:**
- `44a7392` records `:100644 100755 46e47dc 46e47dc M` — a pure mode transition,
  blob hash unchanged. The Risks section's "a content edit that drops the mode
  would silently reintroduce #101" is satisfied.
- `scripts/test-check-scope.sh` invoked directly now exits 0 (was 126) — AC#7.
- Clean-tree lint output is byte-identical to pre-change, exit 0 — AC#9.
- Re-staging the bug with `git update-index --chmod=-x` while the file remained
  `+x` on disk produces `✗ scripts/test-check-scope.sh: committed mode 100644 …`
  and exit 1 — proving the check reads the index, not the filesystem (AC#8).
- All 11 cases pass.


## Wave 2 notes

**Acceptance fixture (issue #98).** `scripts/lint-plan.sh
.agents/plans/gate-legibility-lints.md`: 3 stale-premise warnings → **0**; the 11
`self-protected path` warnings are byte-identical before and after; exit code
stays 0. Total warnings 14 → 11. All three suppressed warnings were false —
`.github/workflows/ci.yml`, `scripts/lint-shell-safety.sh`, and `harness/spine.js`
are all present on `origin/main`; only the bare basename was being existence-
checked at the repo root.

**Population check.** Across all 32 files in `.agents/plans/`, stale-premise
warnings drop 30 → 21, and `comm -13` against the pre-change run shows **zero new
warnings introduced**. The change is pure noise reduction, not a re-shuffle.

**Fail-closed on the new git read.** `resolve_anchor_path` returns 2 with a reason
on stderr when `git ls-files` fails, and never lets a git error look like "no
match". Because the call site sits inside a command substitution whose exit status
cannot reach the caller, the failure travels out as the in-band sentinel
`RAD_ANCHOR_RESOLVE_FAILED` (a string un-representable in the anchor grep's
`[A-Za-z0-9._/-]` charset), which `plan_cited_anchors` converts back to `return 2`.
Verified end-to-end by sourcing the lib outside a git repo: `git ls-files` exits
128, `resolve_anchor_path` returns 2, and `plan_cited_anchors` returns 2 with a
message rather than an empty (silently-dropped) anchor set.

**True positives preserved.** A plan citing `harness/does-not-exist.js:12` still
warns. A bare basename with zero or ≥2 tracked matches emits nothing by design —
verified with `harness-ci.md` (3 tracked matches) — since a guess is worse than no
signal.

**Concern, not fixed (pre-existing, filed for Wave 4 or a follow-up).**
`scripts/lib/plan-paths.sh` declares "bash 3.2 (macOS stock) compatible" in its
header, but it has not parsed under bash 3.2 since the premise-freshness lint
landed: `/bin/bash -n scripts/lib/plan-paths.sh` fails with `syntax error near
unexpected token ';;'` at the `case "$token" in *//*) continue ;; esac` line. This
is the bash 3.2 `$( )` parser bug — a `)` in a case pattern inside a command
substitution closes the substitution early; the fix is to write the patterns with
a leading paren (`(*//*)`). It predates this branch, is unrelated to #98, and
fixing it would widen the Wave 2 diff, so it was left alone. It matters because on
a stock macOS box without a newer bash on PATH, `scripts/lint-plan.sh` fails
outright rather than linting. All Wave 2 code was written to stay 3.2-safe
(here-strings and `[[ ]]` only, no new case patterns inside the substitution).
