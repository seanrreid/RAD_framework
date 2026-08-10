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

