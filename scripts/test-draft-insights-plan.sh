#!/usr/bin/env bash
# test-draft-insights-plan.sh
# Tests for scripts/draft-insights-plan.sh: nothing-to-draft (exit 0, no
# branch), one plan + one branch + one plan-only commit for two crossing
# categories (one mapped, one unmapped), the drafted plan linting clean yet
# blocked by check-approval-blockers.sh (markers), refusals (existing branch,
# dirty tracked file → exit 1, nothing written), missing log → exit 2,
# --dry-run touching nothing, and the Step 3b threshold fallback. Runs in a
# hermetic GREPO fixture with a local bare origin. bash 3.2+ safe.
#
# Usage: scripts/test-draft-insights-plan.sh   (exit 0 + "ALL PASS")

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

DATE="$(date +%Y-%m-%d)"
BRANCH="rad/insights-proposals-$DATE"
PLAN=".agents/plans/insights-proposals-$DATE.md"
GREPO="$TMP/grepo"
OUT="$TMP/out.txt"
ERR="$TMP/err.txt"

# setup_grepo — fixture repo on main, pushed to a local bare origin, carrying
# the scripts the drafter and lint need plus a CLAUDE.md with conventions.
setup_grepo() {
  mkdir -p "$GREPO/scripts/lib" "$GREPO/.agents"
  cp "$HERE/draft-insights-plan.sh" "$HERE/lint-plan.sh" "$HERE/check-approval-blockers.sh" \
    "$HERE/get-default-branch.sh" "$GREPO/scripts/"
  cp "$HERE/lib/plan-paths.sh" "$GREPO/scripts/lib/"
  printf '# Project\ndefault_branch: main\n\n## Coding Conventions\n\n- existing bullet\n\n## Testing Standards\n' \
    > "$GREPO/CLAUDE.md"
  git -C "$GREPO" init -q
  git -C "$GREPO" config user.email t@t.t
  git -C "$GREPO" config user.name t
  git -C "$GREPO" checkout -q -b main
  git -C "$GREPO" add -A
  git -C "$GREPO" commit -q -m baseline
  git init -q --bare "$TMP/origin.git"
  git -C "$GREPO" remote add origin "$TMP/origin.git"
  git -C "$GREPO" push -q origin main
}

# write_findings <file> <category:count>... — findings records plus one
# non-finding record (must be ignored by the category count).
write_findings() {
  local file="$1" spec cat n i
  shift
  : > "$file"
  for spec in "$@"; do
    cat="${spec%%:*}" n="${spec##*:}"
    for ((i = 0; i < n; i++)); do
      printf '{"type":"finding","category":"%s","issue":"x"}\n' "$cat" >> "$file"
    done
  done
  printf '{"type":"review","category":"testing"}\n' >> "$file"
}

# run_draft [env-assignment...] -- <args...> — run the drafter in GREPO; sets RC.
run_draft() {
  local envs=()
  while [[ "$1" != "--" ]]; do envs+=("$1"); shift; done
  shift
  if ( cd "$GREPO" && env -u RAD_FINDINGS_THRESHOLD -u RAD_BRANCH_PREFIX \
      RAD_FINDINGS_FILE="$TMP/findings.jsonl" ${envs[@]+"${envs[@]}"} \
      bash scripts/draft-insights-plan.sh ${1+"$@"} ) >"$OUT" 2>"$ERR"; then
    RC=0
  else
    RC=$?
  fi
}

expect() { [[ "$RC" -eq "$2" ]] || fail "$1: expected exit $2, got $RC (stderr: $(cat "$ERR"))"; }
branches() { git -C "$GREPO" branch --list; }
status() { git -C "$GREPO" status --porcelain; }

setup_grepo

# ── Below threshold → nothing to draft, no branch ─────────────────────────────
write_findings "$TMP/findings.jsonl" testing:4 portability:2
run_draft -- ; expect "AC#10 below-threshold" 0
grep -qx "nothing to draft (threshold 5)" "$OUT" || fail "AC#10: missing 'nothing to draft' line: $(cat "$OUT")"
[[ "$(branches)" == "* main" ]] || fail "AC#10: below-threshold created a branch: $(branches)"
echo "✓ AC#10: below-threshold log prints 'nothing to draft', exit 0, no branch"

# ── Empty findings log → nothing to draft ─────────────────────────────────────
: > "$TMP/findings.jsonl"
run_draft -- ; expect "AC#10 empty-log" 0
grep -q "nothing to draft" "$OUT" || fail "AC#10: empty log did not print 'nothing to draft'"
echo "✓ AC#10: empty findings log prints 'nothing to draft', exit 0"

# ── Threshold parse: abc → 5 (boundary: count 5 crosses, 4 does not) ──────────
write_findings "$TMP/findings.jsonl" testing:5 portability:4
run_draft RAD_FINDINGS_THRESHOLD=abc -- --dry-run; expect "AC#10 threshold=abc" 0
grep -q '`testing`: 5 findings (threshold 5)' "$OUT" || fail "AC#10: threshold=abc did not fall back to 5"
grep -q 'portability' "$OUT" && fail "AC#10: 4 < 5 must not cross the threshold"
for bad in 0 -3 ""; do
  run_draft RAD_FINDINGS_THRESHOLD="$bad" -- --dry-run; expect "AC#10 threshold=[$bad]" 0
  grep -q '(threshold 5)' "$OUT" || fail "AC#10: threshold [$bad] did not fall back to 5"
done
run_draft RAD_FINDINGS_THRESHOLD=4x -- --dry-run; expect "AC#10 threshold=4x" 0
grep -q '`portability`: 4 findings (threshold 4)' "$OUT" || fail "AC#10: threshold 4x must parse as 4 (parseInt)"
echo "✓ AC#10: RAD_FINDINGS_THRESHOLD abc/0/-3/empty → 5; 4x → 4; count == threshold crosses"

# ── --dry-run prints the plan and touches nothing ─────────────────────────────
write_findings "$TMP/findings.jsonl" testing:6 portability:7
before_b="$(branches)" before_s="$(status)"
run_draft -- --dry-run; expect "AC#10 dry-run" 0
grep -q "^# Plan: Insights Proposals $DATE" "$OUT" || fail "AC#10: --dry-run did not print the plan"
[[ "$(branches)" == "$before_b" && "$(status)" == "$before_s" ]] || fail "AC#10: --dry-run changed git state"
[[ ! -e "$GREPO/$PLAN" ]] || fail "AC#10: --dry-run wrote the plan file"
echo "✓ AC#10: --dry-run prints the plan, branch list and status unchanged, no file"

# ── Unknown flag → usage, exit 2 ──────────────────────────────────────────────
run_draft -- --bogus; expect "AC#10 unknown flag" 2
grep -q "usage" "$ERR" || fail "AC#10: unknown flag did not print usage"
echo "✓ AC#10: unknown flag prints usage, exit 2"

# ── Missing findings log → exit 2 ─────────────────────────────────────────────
run_draft RAD_FINDINGS_FILE="$TMP/absent.jsonl" -- ; expect "AC#10 missing log" 2
grep -q "absent.jsonl" "$ERR" || fail "AC#10: missing-log stderr does not name the file"
echo "✓ AC#10: missing findings log exits 2 naming the file"

# ── Dirty tracked file → exit 1, nothing written ──────────────────────────────
echo "dirty" >> "$GREPO/CLAUDE.md"
run_draft -- ; expect "AC#10 dirty" 1
grep -q "uncommitted" "$ERR" || fail "AC#10: dirty refusal does not name the problem"
[[ "$(branches)" == "* main" && ! -e "$GREPO/$PLAN" ]] || fail "AC#10: dirty refusal wrote something"
git -C "$GREPO" checkout -q -- CLAUDE.md
echo "✓ AC#10: dirty tracked file exits 1, nothing written"

# ── Two crossing categories → one plan, one branch, one plan-only commit ─────
run_draft -- ; expect "AC#10 draft" 0
grep -qx "drafted: $PLAN on $BRANCH" "$OUT" || fail "AC#10: missing drafted line: $(cat "$OUT")"
[[ "$(git -C "$GREPO" rev-parse --abbrev-ref HEAD)" == "$BRANCH" ]] || fail "AC#10: not on $BRANCH"
[[ "$(git -C "$GREPO" rev-list --count main..HEAD)" -eq 1 ]] || fail "AC#10: expected exactly one commit"
[[ "$(git -C "$GREPO" show --name-only --format= HEAD)" == "$PLAN" ]] || fail "AC#10: commit must contain only the plan"
msg="$(git -C "$GREPO" log -1 --format=%B)"
for want in "adopt: Insights Proposals $DATE" "Adopted-From: /rad-insights --draft-plans" \
  "Author: insights-draft" "Waves: 1" "Tasks: 2"; do
  printf '%s\n' "$msg" | grep -qF "$want" || fail "AC#10: commit message lacks '$want'"
done
git -C "$GREPO" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1 \
  && fail "AC#10: the drafter pushed the branch"
echo "✓ AC#10: two crossing categories → one plan, one branch, one plan-only commit, never pushed"

P="$GREPO/$PLAN"
grep -q "^#### Task 1.1: portability lint rule" "$P" || fail "AC#10: unmapped category not first (count desc) or not a lint task"
grep -q "^File: scripts/lint-portability.sh:1-40, scripts/test-lint-portability.sh:1-40" "$P" \
  || fail "AC#10: unmapped task lacks lint + co-located fixture paths"
grep -q "^#### Task 1.2: testing convention bullet" "$P" || fail "AC#10: mapped category lacks a convention task"
grep -q "^File: CLAUDE.md:4-7" "$P" || fail "AC#10: convention task does not cite the Coding Conventions range"
[[ "$(grep -c '^\[NEEDS CLARIFICATION: exact wording/regex for the .* rule\]$' "$P")" -eq 2 ]] \
  || fail "AC#10: each task must carry its own clarification marker line"
echo "✓ AC#10: mapped → convention bullet task, unmapped → lint + fixture task, one marker each"

# ── The drafted plan lints clean (in GREPO) and is approval-blocked ──────────
set +e
LINT_OUT=$( cd "$GREPO" && bash scripts/lint-plan.sh "$PLAN" 2>&1 ); LINT_RC=$?
( cd "$GREPO" && bash scripts/check-approval-blockers.sh "$PLAN" ) >/dev/null 2>"$ERR"; BLOCK_RC=$?
set -e
[[ "$LINT_RC" -eq 0 ]] || fail "AC#11: lint exited $LINT_RC: $LINT_OUT"
printf '%s\n' "$LINT_OUT" | grep -q "Errors" && fail "AC#11: lint reported errors: $LINT_OUT"
[[ "$BLOCK_RC" -ne 0 ]] || fail "AC#11: check-approval-blockers.sh passed a plan with markers"
grep -q "clarification" "$ERR" || fail "AC#11: blockers did not name the markers: $(cat "$ERR")"
echo "✓ AC#11: drafted plan passes lint-plan.sh with no errors; check-approval-blockers.sh refuses it"

# ── Re-run with the branch present → exit 1, nothing written ─────────────────
git -C "$GREPO" checkout -q main
run_draft -- ; expect "AC#10 branch exists" 1
grep -q "already exists locally" "$ERR" || fail "AC#10: branch refusal does not name the problem"
[[ -z "$(status)" && ! -e "$GREPO/$PLAN" ]] || fail "AC#10: branch refusal wrote something"
git -C "$GREPO" branch -q -D "$BRANCH"
git -C "$GREPO" push -q origin "main:refs/heads/$BRANCH"
run_draft -- ; expect "AC#10 branch on origin" 1
grep -q "already exists on origin" "$ERR" || fail "AC#10: origin refusal does not name the problem"
git -C "$GREPO" push -q origin --delete "$BRANCH"
git -C "$GREPO" remote set-url origin "$TMP/gone.git"
run_draft -- ; expect "AC#10 origin unreachable" 1
grep -q "cannot verify origin" "$ERR" || fail "AC#10: unreachable origin not reported fail-closed"
[[ "$(branches)" == "* main" ]] || fail "AC#10: origin refusals created a branch"
echo "✓ AC#10: branch present locally / on origin / origin unverifiable → exit 1, nothing written"

echo "ALL PASS"
