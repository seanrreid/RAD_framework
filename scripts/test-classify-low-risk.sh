#!/usr/bin/env bash
# test-classify-low-risk.sh
# Predicate unit tests for classify-low-risk.sh — the deterministic, fail-closed
# severity router. A plan is LOW (auto-clearable, exit 0) iff ALL hold:
#   0. NO touched path is self-protected RAD machinery (lib/plan-paths.sh
#      literal — never operator-tunable).
#   1. RAD_LOW_RISK_PATTERNS is non-empty.
#   2. Every touched path matches RAD_LOW_RISK_PATTERNS.
#   3. NO touched path matches RAD_HIGH_RISK_PATTERNS (high wins ties).
#   4. The declared scope is unchanged vs the working git diff (no drift).
# Anything else yields NOT-LOW (exit 1). Fail closed.
#
# Self-contained (no external harness): builds a temp git-repo fixture (so rule 4
# has a real diff to read), commits fixture plans on the BASELINE, then exercises
# rules 1-3 from work branches whose only diff is in-scope source edits — so rule
# 4 never masks the predicate under test. Mirrors the style of test-lint-plan.sh /
# test-check-scope.sh. Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-classify-low-risk.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

REPO="$TMP/repo"
mkdir -p "$REPO/scripts/lib" "$REPO/.agents/plans" "$REPO/docs" "$REPO/styles" \
         "$REPO/src/auth" "$REPO/tests" "$REPO/config" \
         "$REPO/harness" "$REPO/.agents/state/demo"
cp "$HERE/classify-low-risk.sh" "$HERE/get-default-branch.sh" "$REPO/scripts/"
cp "$HERE/lib/plan-paths.sh" "$REPO/scripts/lib/"
printf '**Name:** t\ndefault_branch: main\n' > "$REPO/CLAUDE.md"

# Baseline content for every path a fixture plan might declare.
printf '# guide\n'         > "$REPO/docs/guide.md"
printf '.a{color:red}\n'   > "$REPO/styles/main.css"
printf 'export const x=1\n' > "$REPO/src/auth/login.js"
printf 'test("x",()=>{})\n' > "$REPO/tests/unit.test.js"
printf 'key=val\n'         > "$REPO/config/app.conf"
printf 'module.exports={}\n' > "$REPO/harness/gates.js"
printf '{}\n'              > "$REPO/.agents/state/demo/events.jsonl"

# write_plan <out> <scope-rows> — minimal plan with the given Files-in-Scope rows.
write_plan() {
  local out="$1" scope_rows="$2"
  {
    cat <<'EOF'
# Plan: classify-test
Status: pending-review
Branch: rad/classify-test

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
EOF
    [[ -n "$scope_rows" ]] && printf '%s\n' "$scope_rows"
  } > "$out"
}

# All plans live on the BASELINE (main) so they are never part of a work branch's
# diff vs main — otherwise the plan doc itself would register as scope drift
# (rule 4) and mask the rules 1-3 predicate under test.
write_plan "$REPO/.agents/plans/off.md"          "| docs/guide.md | 1 | x |"
write_plan "$REPO/.agents/plans/low.md"          "$(printf '| docs/guide.md | 1 | x |\n| styles/main.css | 1 | x |')"
write_plan "$REPO/.agents/plans/high.md"         "$(printf '| docs/guide.md | 1 | x |\n| src/auth/login.js | 1 | x |')"
write_plan "$REPO/.agents/plans/outside.md"      "$(printf '| docs/guide.md | 1 | x |\n| config/app.conf | 1 | x |')"
write_plan "$REPO/.agents/plans/tests-config.md" "$(printf '| tests/unit.test.js | 1 | x |\n| config/app.conf | 1 | x |')"
write_plan "$REPO/.agents/plans/selfprot-harness.md"  "| harness/gates.js | 1 | x |"
write_plan "$REPO/.agents/plans/selfprot-scripts.md"  "| scripts/classify-low-risk.sh | 1 | x |"
write_plan "$REPO/.agents/plans/selfprot-state.md"    "| .agents/state/demo/events.jsonl | 1 | x |"

git -C "$REPO" init -q
git -C "$REPO" config user.email "t@t.t"
git -C "$REPO" config user.name "t"
git -C "$REPO" checkout -q -b main
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "baseline (sources + plans)"

# run_classify <plan-rel-path> <work-branch>
# Run the real classifier inside the fixture repo against a work branch. Captures
# exit code without tripping set -e (these tests assert on the code). Honors
# RAD_LOW_RISK_PATTERNS / RAD_HIGH_RISK_PATTERNS exported by the caller.
CLASSIFY_OUT=""
CLASSIFY_CODE=0
run_classify() {
  local plan="$1" branch="$2"
  set +e
  CLASSIFY_OUT=$( cd "$REPO" && bash scripts/classify-low-risk.sh "$plan" "$branch" main 2>&1 )
  CLASSIFY_CODE=$?
  set -e
}

# branch_edit <name> <file> <content> [<file2> <content2> ...]
# Cut a fresh work branch from main and commit in-scope edits to the given files
# (these become the branch's diff vs main, satisfying rule 4).
branch_edit() {
  local name="$1"; shift
  git -C "$REPO" checkout -q main
  git -C "$REPO" checkout -q -B "$name" main
  while [[ $# -ge 2 ]]; do
    printf '%s\n' "$2" > "$REPO/$1"
    shift 2
  done
  git -C "$REPO" add -A
  git -C "$REPO" commit -q -m "in-scope edits on $name"
}

# ── AC#1: empty/unset RAD_LOW_RISK_PATTERNS ⇒ not-low (severity routing OFF) ────
t_off_when_unset() {
  # An all-docs/CSS plan that WOULD be low if the allowlist were set.
  branch_edit rad/off docs/guide.md '# guide v2'

  ( unset RAD_LOW_RISK_PATTERNS; run_classify ".agents/plans/off.md" "rad/off"
    [[ "$CLASSIFY_CODE" -eq 1 ]] || fail "AC#1: unset allowlist should be not-low (got $CLASSIFY_CODE): $CLASSIFY_OUT"
    printf '%s\n' "$CLASSIFY_OUT" | grep -q "verdict: not-low" \
      || fail "AC#1: unset allowlist did not print not-low verdict"
  ) || exit 1
  echo "✓ AC#1a: unset RAD_LOW_RISK_PATTERNS ⇒ not-low (OFF)"

  ( export RAD_LOW_RISK_PATTERNS=""; run_classify ".agents/plans/off.md" "rad/off"
    [[ "$CLASSIFY_CODE" -eq 1 ]] || fail "AC#1: empty allowlist should be not-low (got $CLASSIFY_CODE)"
  ) || exit 1
  echo "✓ AC#1b: empty RAD_LOW_RISK_PATTERNS ⇒ not-low (OFF)"
}

# ── AC#2: all docs/CSS scope + matching allowlist ⇒ LOW ────────────────────────
t_low_when_all_inert() {
  branch_edit rad/low docs/guide.md '# guide v2' styles/main.css '.a{color:blue}'

  ( export RAD_LOW_RISK_PATTERNS='\.md$|\.css$'; run_classify ".agents/plans/low.md" "rad/low"
    [[ "$CLASSIFY_CODE" -eq 0 ]] || fail "AC#2: all-inert plan should be LOW (got $CLASSIFY_CODE): $CLASSIFY_OUT"
    printf '%s\n' "$CLASSIFY_OUT" | grep -q "verdict: low" \
      || fail "AC#2: all-inert plan did not print low verdict"
  ) || exit 1
  echo "✓ AC#2: all docs/CSS scope + matching allowlist ⇒ LOW"
}

# ── AC#4: a high-risk token (auth) ⇒ not-low even if it also matches allowlist ─
t_high_wins_ties() {
  # src/auth/login.js matches the high-risk default ("auth") AND a broad ".js$"
  # allowlist — high must win.
  branch_edit rad/high docs/guide.md '# guide v2' src/auth/login.js 'export const x=2'

  ( export RAD_LOW_RISK_PATTERNS='\.md$|\.js$'; run_classify ".agents/plans/high.md" "rad/high"
    [[ "$CLASSIFY_CODE" -eq 1 ]] || fail "AC#4: high-risk auth path should be not-low (got $CLASSIFY_CODE): $CLASSIFY_OUT"
    printf '%s\n' "$CLASSIFY_OUT" | grep -q "high-risk path" \
      || fail "AC#4: not-low verdict did not cite the high-risk path"
  ) || exit 1
  echo "✓ AC#4a: high-risk token (auth) ⇒ not-low even when allowlist would match (high wins ties)"
}

# ── AC#4: a path NOT matching the allowlist ⇒ not-low ──────────────────────────
t_not_low_when_outside_allowlist() {
  # config/app.conf does not match a docs/CSS-only allowlist.
  branch_edit rad/outside docs/guide.md '# guide v2' config/app.conf 'key=val2'

  ( export RAD_LOW_RISK_PATTERNS='\.md$|\.css$'; run_classify ".agents/plans/outside.md" "rad/outside"
    [[ "$CLASSIFY_CODE" -eq 1 ]] || fail "AC#4: path outside allowlist should be not-low (got $CLASSIFY_CODE): $CLASSIFY_OUT"
    printf '%s\n' "$CLASSIFY_OUT" | grep -q "outside the low-risk allowlist" \
      || fail "AC#4: not-low verdict did not cite the outside-allowlist path"
  ) || exit 1
  echo "✓ AC#4b: a path not matching the allowlist ⇒ not-low"
}

# ── AC#4: tests/config NOT auto-cleared under a docs/CSS allowlist ─────────────
# The classifier ships NO baked-in low-risk default — the operator must opt in.
# A docs/CSS-shaped allowlist (the documented tight default) must NOT clear a
# tests/ or config/ path: they fall through to "outside the allowlist".
t_tests_config_not_cleared() {
  branch_edit rad/tests-config tests/unit.test.js 'test("y",()=>{})' config/app.conf 'key=val2'

  ( export RAD_LOW_RISK_PATTERNS='\.md$|\.css$'; run_classify ".agents/plans/tests-config.md" "rad/tests-config"
    [[ "$CLASSIFY_CODE" -eq 1 ]] || fail "AC#4: tests/config should NOT be auto-cleared (got $CLASSIFY_CODE): $CLASSIFY_OUT"
    printf '%s\n' "$CLASSIFY_OUT" | grep -q "outside the low-risk allowlist" \
      || fail "AC#4: tests/config not-low verdict did not cite the allowlist"
  ) || exit 1
  echo "✓ AC#4c: tests/ and config/ are NOT auto-cleared under a docs/CSS allowlist"
}

# ── Rule 4: scope drift — branch changes a file OUTSIDE declared scope ⇒ not-low ─
# The low.md plan declares docs/guide.md + styles/main.css (all-low). But the work
# branch also edits config/app.conf, which is NOT in the declared scope. Even though
# every DECLARED path is low, the out-of-scope change must force not-low.
t_scope_drift_not_low() {
  branch_edit rad/drift docs/guide.md '# guide v2' config/app.conf 'key=drift'

  ( export RAD_LOW_RISK_PATTERNS='\.md$|\.css$'; run_classify ".agents/plans/low.md" "rad/drift"
    [[ "$CLASSIFY_CODE" -eq 1 ]] || fail "AC: out-of-scope change should be not-low (got $CLASSIFY_CODE): $CLASSIFY_OUT"
    printf '%s\n' "$CLASSIFY_OUT" | grep -q "scope drift" \
      || fail "AC: not-low verdict did not cite scope drift: $CLASSIFY_OUT"
  ) || exit 1
  echo "✓ AC#scope-drift: a change outside the declared scope ⇒ not-low"
}

# ── Rule 1 (fail-closed): an empty changed-file set vs base ⇒ not-low ───────────
# A work branch with no commits diverging from main produces an empty diff. An empty
# diff is ambiguous (wrong base / no commits) and must NOT auto-clear.
t_empty_diff_not_low() {
  # Branch off main with NO commits — its diff vs main is empty.
  git -C "$REPO" checkout -q main
  git -C "$REPO" checkout -q -B rad/empty main

  ( export RAD_LOW_RISK_PATTERNS='\.md$|\.css$'; run_classify ".agents/plans/low.md" "rad/empty"
    [[ "$CLASSIFY_CODE" -eq 1 ]] || fail "AC: empty diff should be not-low (got $CLASSIFY_CODE): $CLASSIFY_OUT"
    printf '%s\n' "$CLASSIFY_OUT" | grep -q "no changed files detected" \
      || fail "AC: not-low verdict did not cite the empty changed-file set: $CLASSIFY_OUT"
  ) || exit 1
  echo "✓ AC#empty-diff: an empty changed-file set ⇒ not-low (fail closed)"
}

# ── Rule 0: self-protected RAD machinery ⇒ not-low, even under a '.*' allowlist ─
# The self-protected set is a literal in lib/plan-paths.sh — no operator pattern
# (broad allowlist, emptied high-risk set) can loosen it.
t_self_protected_not_low() {
  # (a) harness/gates.js under the broadest possible allowlist.
  branch_edit rad/selfprot-a harness/gates.js 'module.exports={v:2}'

  ( export RAD_LOW_RISK_PATTERNS='.*'; run_classify ".agents/plans/selfprot-harness.md" "rad/selfprot-a"
    [[ "$CLASSIFY_CODE" -eq 1 ]] || fail "AC#1: harness/gates.js should be not-low under '.*' (got $CLASSIFY_CODE): $CLASSIFY_OUT"
    printf '%s\n' "$CLASSIFY_OUT" | grep -q "self-protected" \
      || fail "AC#1: not-low verdict did not cite the self-protected rule: $CLASSIFY_OUT"
  ) || exit 1
  echo "✓ AC#self-protected-a: harness/gates.js ⇒ not-low even under a '.*' allowlist"

  # (b) scripts/classify-low-risk.sh with the high-risk set emptied — rule 0
  # must fire regardless of RAD_HIGH_RISK_PATTERNS. Rule 0 reasons over the
  # DECLARED scope and precedes rule 4, so the branch edits a neutral file
  # (editing the classifier itself would clobber the script under test).
  branch_edit rad/selfprot-b docs/guide.md '# guide selfprot-b'

  ( export RAD_LOW_RISK_PATTERNS='.*'; export RAD_HIGH_RISK_PATTERNS=""
    run_classify ".agents/plans/selfprot-scripts.md" "rad/selfprot-b"
    [[ "$CLASSIFY_CODE" -eq 1 ]] || fail "AC#1: scripts/ should be not-low with empty high-risk set (got $CLASSIFY_CODE): $CLASSIFY_OUT"
    printf '%s\n' "$CLASSIFY_OUT" | grep -q "self-protected path (RAD machinery): scripts/classify-low-risk.sh" \
      || fail "AC#1: not-low verdict did not name the self-protected scripts/ path: $CLASSIFY_OUT"
  ) || exit 1
  echo "✓ AC#self-protected-b: scripts/ ⇒ not-low even with RAD_HIGH_RISK_PATTERNS emptied"

  # (c) .agents/state/ — the event-log authority itself.
  branch_edit rad/selfprot-c .agents/state/demo/events.jsonl '{"v":2}'

  ( export RAD_LOW_RISK_PATTERNS='.*'; run_classify ".agents/plans/selfprot-state.md" "rad/selfprot-c"
    [[ "$CLASSIFY_CODE" -eq 1 ]] || fail "AC#1: .agents/state/ should be not-low (got $CLASSIFY_CODE): $CLASSIFY_OUT"
    printf '%s\n' "$CLASSIFY_OUT" | grep -q "self-protected path (RAD machinery): .agents/state/demo/events.jsonl" \
      || fail "AC#1: not-low verdict did not name the self-protected state path: $CLASSIFY_OUT"
  ) || exit 1
  echo "✓ AC#self-protected-c: .agents/state/ ⇒ not-low"
}

# ── Rule 0 regression: a docs-only plan under the documented default allowlist ──
# Rule 0 must not disturb the normal LOW path for genuinely inert scopes.
t_self_protected_docs_regression() {
  branch_edit rad/selfprot-docs docs/guide.md '# guide v3'

  ( export RAD_LOW_RISK_PATTERNS='css|scss|\.(png|jpe?g|gif|svg|webp|woff2?|ttf|otf|eot)$|\.md$|^docs/'
    run_classify ".agents/plans/off.md" "rad/selfprot-docs"
    [[ "$CLASSIFY_CODE" -eq 0 ]] || fail "AC#4: docs-only plan should still be LOW (got $CLASSIFY_CODE): $CLASSIFY_OUT"
    printf '%s\n' "$CLASSIFY_OUT" | grep -q "verdict: low" \
      || fail "AC#4: docs-only plan did not print low verdict: $CLASSIFY_OUT"
  ) || exit 1
  echo "✓ AC#self-protected-d: docs-only plan under the default allowlist ⇒ still LOW"
}

t_off_when_unset
t_low_when_all_inert
t_high_wins_ties
t_not_low_when_outside_allowlist
t_tests_config_not_cleared
t_scope_drift_not_low
t_empty_diff_not_low
t_self_protected_not_low
t_self_protected_docs_regression
echo "ALL PASS"
